/**
 * GitHub 作者动态追踪器
 *
 * 工作方式：
 *   1. 按 intervalSec 轮询每个作者的公开事件（/users/{login}/events/public）
 *   2. 首次成功轮询只建立基线（历史事件记为 skipped，不推送），避免加人时刷屏
 *   3. 新事件写入 github_events，按 occurred_at 顺序推送
 *   4. 推送目标是**本功能页自己配置的会话**（config/github.yaml 的 targets），
 *      完全不走 trigger 里的群/用户白名单 —— 面板上单独设置，互不影响
 *   5. OneBot 离线或某个会话发送失败时保留 pending，下轮补发；超过重试上限/48 小时转 failed
 *
 * 去重与重试都落 SQLite（github_events / github_deliveries / github_authors），
 * 重启不会把同一批事件再发一遍。
 */
import type { Logger } from '../core/logger.js';
import { errorDetails } from '../core/logger.js';
import type { ObMessageSegment } from '../core/types.js';
import type { MemoryStore } from '../memory/store.js';
import {
  GITHUB_EVENT_LABELS,
  GITHUB_EVENT_TYPES,
  publicGithubConfig,
  saveGithubConfig,
  validateGithubConfig,
  type GithubAuthorConfig,
  type GithubConfig,
  type GithubTargetConfig,
  type PublicGithubConfig,
} from './config.js';
import {
  cleanGithubText,
  formatGithubTime,
  parseGithubEvent,
  renderGithubEvent,
  renderGithubTestMessage,
} from './format.js';

/** 只依赖 sendToScope，OneBotAction 与本接口结构化兼容，测试里可以换成假实现 */
export interface GithubDeliverySender {
  sendToScope(
    scope: string,
    message: string | ObMessageSegment[],
    opts?: { throwOnError?: boolean; timeoutMs?: number },
  ): Promise<{ message_id: number }>;
}

export interface GithubHttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type GithubFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<GithubHttpResponse>;

export interface GithubTrackerOptions {
  root: string;
  config: GithubConfig;
  sender: GithubDeliverySender;
  store: MemoryStore;
  log: Logger;
  ready: () => boolean;
  timezone?: string;
  fetchImpl?: GithubFetch;
  now?: () => number;
}

export interface GithubPollResult {
  ok: boolean;
  busy?: boolean;
  fetched: number;
  delivered: number;
  errors: string[];
}

export interface GithubTestResult {
  ok: boolean;
  results: Array<{ scope: string; ok: boolean; messageId?: number; error?: string }>;
}

export interface GithubAuthorView {
  login: string;
  enabled: boolean;
  baselineAt: number;
  lastPolledAt: number;
  lastEventAt: number;
  lastError: string;
  total: number;
  pending: number;
}

export interface GithubTargetView {
  scope: string;
  enabled: boolean;
  title: string;
  sent: number;
  failed: number;
  lastSentAt: number;
}

export interface GithubEventView {
  eventId: string;
  login: string;
  type: string;
  repo: string;
  summary: string;
  occurredAt: number;
  state: string;
  attempts: number;
  lastError: string;
}

export interface GithubDeliveryView {
  eventId: string;
  scope: string;
  status: string;
  messageId: number | null;
  error: string;
  createdAt: number;
  summary: string;
  login: string;
}

export interface GithubSnapshot {
  config: PublicGithubConfig;
  runtime: {
    enabled: boolean;
    running: boolean;
    polling: boolean;
    lastPollAt: number;
    nextPollAt: number;
    lastError: string;
    pendingCount: number;
    rate: { limit: number | null; remaining: number | null; resetAt: number | null };
  };
  authors: GithubAuthorView[];
  targets: GithubTargetView[];
  knownSessions: Array<{ scope: string; title: string; lastActive: number }>;
  recentEvents: GithubEventView[];
  recentDeliveries: GithubDeliveryView[];
  eventTypes: Array<{ value: string; label: string }>;
}

interface AuthorRow {
  login: string;
  etag: string;
  baseline_at: number;
  last_polled_at: number;
  last_event_at: number;
  last_error: string;
}

interface EventRow {
  event_id: string;
  login: string;
  type: string;
  repo: string;
  summary: string;
  text: string;
  url: string;
  occurred_at: number;
  fetched_at: number;
  state: string;
  attempts: number;
  last_error: string;
}

/** 单次 HTTP 请求上限；GitHub 正常响应远快于此 */
const REQUEST_TIMEOUT_MS = 15000;
/** 每个事件最多重试轮数，超过转 failed，避免永久占用队列 */
const MAX_DELIVERY_ATTEMPTS = 3;
/** 事件超过这个年龄就不再补发 */
const MAX_DELIVERY_AGE_MS = 48 * 3600_000;
/** 已完成/已跳过记录的保留天数 */
const HISTORY_RETENTION_DAYS = 30;

function headerNumber(headers: GithubHttpResponse['headers'], name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

/** 作者列表是否只是同一批人（用户名大小写不敏感），用于判断保存后要不要立刻补一轮 */
function sameAuthors(a: GithubAuthorConfig[], b: GithubAuthorConfig[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index]!;
    return item.login.toLowerCase() === other.login.toLowerCase() && item.enabled === other.enabled;
  });
}

/** 推送会话是否只是同一批 scope，作用同上 */
function sameTargets(a: GithubTargetConfig[], b: GithubTargetConfig[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index]!;
    return item.scope === other.scope && item.enabled === other.enabled;
  });
}

export class GithubTracker {
  private cfg: GithubConfig;
  private readonly root: string;
  private readonly sender: GithubDeliverySender;
  private readonly store: MemoryStore;
  private readonly log: Logger;
  private readonly ready: () => boolean;
  private readonly timezone: string;
  private readonly fetchImpl: GithubFetch;
  private readonly now: () => number;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private active: Promise<GithubPollResult> | null = null;
  private nextPollAt = 0;
  private lastPollAt = 0;
  private lastError = '';
  private rateLimit: number | null = null;
  private rateRemaining: number | null = null;
  private rateResetAt: number | null = null;
  private rateBlockedUntil = 0;

  constructor(opts: GithubTrackerOptions) {
    this.root = opts.root;
    this.cfg = opts.config;
    this.sender = opts.sender;
    this.store = opts.store;
    this.log = opts.log;
    this.ready = opts.ready;
    this.timezone = opts.timezone || 'Asia/Shanghai';
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => Date.now());
    this.store.onClose(() => {
      void this.stop();
    });
    // 手工改配置/停机期间被停用的作者，其遗留的待推送事件不应无限挂着
    this.skipInactivePending();
  }

  get config(): GithubConfig {
    return this.cfg;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // 启动后稍等 OneBot 建链，再开始第一轮
    this.scheduleNext(10_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.nextPollAt = 0;
    if (this.active) {
      try {
        await this.active;
      } catch {
        /* 关闭阶段的异常不向上抛 */
      }
    }
  }

  /** 面板保存：校验 -> 原子写盘 -> 热生效 */
  saveConfig(input: unknown): GithubConfig {
    const result = validateGithubConfig(input, this.cfg);
    if (!result.ok) throw new Error(result.error);
    saveGithubConfig(this.root, result.config);
    this.applyConfig(result.config);
    this.log.info(
      { enabled: result.config.enabled, authors: result.config.authors.length, targets: result.config.targets.length },
      'GitHub 追踪设置已保存并热生效',
    );
    return result.config;
  }

  /** 面板「立即检查」：不等定时器，立刻跑一轮（即使总开关关闭也允许，便于试跑） */
  async pollNow(): Promise<GithubPollResult> {
    if (this.active) {
      return { ok: false, busy: true, fetched: 0, delivered: 0, errors: ['正在检查中，请稍候再试'] };
    }
    return this.runCycle('manual');
  }

  /** 面板「发送测试消息」：给每个启用会话发一条诊断消息，不写入历史 */
  async testSend(): Promise<GithubTestResult> {
    const targets = this.cfg.targets.filter((t) => t.enabled);
    if (targets.length === 0) throw new Error('请先添加并启用至少一个推送会话');
    if (!this.ready()) throw new Error('OneBot 当前未连接，无法发送测试消息');
    const text = renderGithubTestMessage(this.timezone, this.now());
    const results: GithubTestResult['results'] = [];
    for (const target of targets) {
      try {
        const sent = await this.sender.sendToScope(target.scope, [{ type: 'text', data: { text } }], {
          throwOnError: true,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        results.push({ scope: target.scope, ok: true, messageId: sent.message_id });
      } catch (e) {
        results.push({ scope: target.scope, ok: false, error: cleanGithubText((e as Error).message, 200) || '发送失败' });
      }
    }
    return { ok: results.every((r) => r.ok), results };
  }

  /**
   * OneBot 恢复就绪：立刻跑一轮，把离线期间积压的动态补发出去，不必等下一个轮询间隔。
   *
   * 总开关关闭时不触发；已有轮次在跑时 await 当前轮次，避免对 GitHub 重复请求。
   */
  async notifyReady(): Promise<void> {
    if (this.stopped || !this.cfg.enabled) return;
    try {
      await this.runCycle('timer');
    } catch (e) {
      this.log.warn(
        { ...errorDetails(e), reason: (e as Error).message },
        'OneBot 就绪后补发 GitHub 动态失败',
      );
    }
  }

  /** 管理面板一次性拉取的状态快照 */
  snapshot(): GithubSnapshot {
    const authorStats = new Map(
      (
        this.store.db
          .prepare(
            "SELECT lower(login) AS key, COUNT(*) AS total, SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending FROM github_events GROUP BY lower(login)",
          )
          .all() as unknown as Array<{ key: string; total: number; pending: number | null }>
      ).map((row) => [row.key, { total: toNumber(row.total), pending: toNumber(row.pending) }]),
    );
    const authors: GithubAuthorView[] = this.cfg.authors.map((author) => {
      const key = author.login.toLowerCase();
      const row = this.authorRow(key);
      const stat = authorStats.get(key);
      return {
        login: author.login,
        enabled: author.enabled,
        baselineAt: row?.baseline_at ?? 0,
        lastPolledAt: row?.last_polled_at ?? 0,
        lastEventAt: row?.last_event_at ?? 0,
        lastError: row?.last_error ?? '',
        total: stat?.total ?? 0,
        pending: stat?.pending ?? 0,
      };
    });

    const knownSessions = (
      this.store.db
        .prepare('SELECT scope, title, last_active FROM sessions ORDER BY last_active DESC LIMIT 100')
        .all() as unknown as Array<{ scope: string; title: string; last_active: number }>
    ).map((row) => ({ scope: row.scope, title: row.title, lastActive: row.last_active }));
    const titles = new Map(knownSessions.map((s) => [s.scope, s.title]));

    const targetStats = new Map(
      (
        this.store.db
          .prepare(
            "SELECT scope, SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, MAX(CASE WHEN status='sent' THEN created_at END) AS last_sent_at FROM github_deliveries GROUP BY scope",
          )
          .all() as unknown as Array<{ scope: string; sent: number | null; failed: number | null; last_sent_at: number | null }>
      ).map((row) => [
        row.scope,
        { sent: toNumber(row.sent), failed: toNumber(row.failed), lastSentAt: toNumber(row.last_sent_at) },
      ]),
    );
    const targets: GithubTargetView[] = this.cfg.targets.map((target) => {
      const stat = targetStats.get(target.scope);
      return {
        scope: target.scope,
        enabled: target.enabled,
        title: titles.get(target.scope) ?? '',
        sent: stat?.sent ?? 0,
        failed: stat?.failed ?? 0,
        lastSentAt: stat?.lastSentAt ?? 0,
      };
    });

    const recentEvents = (
      this.store.db
        .prepare(
          "SELECT event_id,login,type,repo,summary,occurred_at,state,attempts,last_error FROM github_events WHERE state <> 'skipped' ORDER BY occurred_at DESC LIMIT 30",
        )
        .all() as unknown as Array<Record<string, unknown>>
    ).map((row) => ({
      eventId: String(row['event_id']),
      login: String(row['login']),
      type: String(row['type']),
      repo: String(row['repo']),
      summary: String(row['summary']),
      occurredAt: toNumber(row['occurred_at']),
      state: String(row['state']),
      attempts: toNumber(row['attempts']),
      lastError: String(row['last_error']),
    }));

    const recentDeliveries = (
      this.store.db
        .prepare(
          `SELECT d.event_id,d.scope,d.status,d.message_id,d.error,d.created_at,
                  COALESCE(e.summary,'') AS summary, COALESCE(e.login,'') AS login
           FROM github_deliveries d LEFT JOIN github_events e ON e.event_id = d.event_id
           ORDER BY d.created_at DESC LIMIT 30`,
        )
        .all() as unknown as Array<Record<string, unknown>>
    ).map((row) => ({
      eventId: String(row['event_id']),
      scope: String(row['scope']),
      status: String(row['status']),
      messageId: row['message_id'] === null || row['message_id'] === undefined ? null : toNumber(row['message_id']),
      error: String(row['error']),
      createdAt: toNumber(row['created_at']),
      summary: String(row['summary']),
      login: String(row['login']),
    }));

    return {
      config: publicGithubConfig(this.cfg),
      runtime: {
        enabled: this.cfg.enabled,
        running: !this.stopped,
        polling: this.active !== null,
        lastPollAt: this.lastPollAt,
        nextPollAt: this.nextPollAt,
        lastError: this.lastError,
        pendingCount: this.countPending(),
        rate: { limit: this.rateLimit, remaining: this.rateRemaining, resetAt: this.rateResetAt },
      },
      authors,
      targets,
      knownSessions,
      recentEvents,
      recentDeliveries,
      eventTypes: GITHUB_EVENT_TYPES.map((value) => ({ value, label: GITHUB_EVENT_LABELS[value] })),
    };
  }

  // ============================================================
  // 定时与轮询
  // ============================================================

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, delayMs);
    this.nextPollAt = this.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.runCycle('timer');
    } catch (e) {
      this.log.warn({ ...errorDetails(e), reason: (e as Error).message }, 'GitHub 动态轮询失败');
    }
    if (!this.stopped) this.scheduleNext(this.cfg.intervalSec * 1000);
  }

  private runCycle(reason: 'timer' | 'manual'): Promise<GithubPollResult> {
    if (this.active) return this.active;
    const promise = this.cycle(reason).finally(() => {
      this.active = null;
    });
    this.active = promise;
    return promise;
  }

  private async cycle(reason: 'timer' | 'manual'): Promise<GithubPollResult> {
    const startedAt = this.now();
    this.lastError = '';
    const errors: string[] = [];
    let fetched = 0;

    if (!this.cfg.enabled && reason !== 'manual') {
      return { ok: true, fetched: 0, delivered: 0, errors };
    }

    if (this.rateBlockedUntil > startedAt) {
      errors.push(`GitHub 接口限额已用尽，${formatGithubTime(this.rateBlockedUntil, this.timezone)} 后恢复`);
    } else {
      for (const author of this.cfg.authors.filter((a) => a.enabled)) {
        if (this.stopped) break;
        try {
          fetched += await this.pollAuthor(author, startedAt);
        } catch (e) {
          const message = cleanGithubText((e as Error).message, 300) || '未知错误';
          this.markAuthorError(author.login, message);
          errors.push(`${author.login}：${message}`);
          this.log.warn(
            { githubAuthor: author.login, ...errorDetails(e), reason: message },
            'GitHub 作者动态拉取失败',
          );
        }
        if (this.rateRemaining === 0) break;
      }
    }

    const enabledTargets = this.cfg.targets.filter((t) => t.enabled);
    let delivered = 0;
    if (enabledTargets.length === 0) {
      if (this.countPending() > 0) {
        this.store.db
          .prepare("UPDATE github_events SET state='skipped', last_error=? WHERE state='pending'")
          .run('没有启用的推送会话');
      }
    } else {
      delivered = await this.deliverPending(startedAt);
    }

    const finishedAt = this.now();
    if (reason === 'manual' || this.cfg.enabled) this.lastPollAt = finishedAt;
    this.lastError = errors[0] ?? '';
    this.prune(finishedAt);
    if (fetched > 0 || delivered > 0) this.log.info({ fetched, delivered, reason }, 'GitHub 动态检查完成');
    return { ok: errors.length === 0, fetched, delivered, errors };
  }

  private async pollAuthor(author: GithubAuthorConfig, now: number): Promise<number> {
    const key = author.login.toLowerCase();
    const row = this.ensureAuthorRow(key);
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'qq-agent-github-tracker',
      'x-github-api-version': '2022-11-28',
    };
    if (this.cfg.token) headers['authorization'] = `Bearer ${this.cfg.token}`;
    if (row.etag) headers['if-none-match'] = row.etag;

    const url = `${this.cfg.apiBase}/users/${encodeURIComponent(author.login)}/events/public?per_page=30`;
    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    this.updateRate(response.headers);

    if (response.status === 304) {
      this.store.db
        .prepare('UPDATE github_authors SET last_polled_at=?, last_error=? WHERE login=?')
        .run(now, '', key);
      return 0;
    }
    if (response.status === 404) throw new Error('GitHub 用户不存在或已改名');
    if (!response.ok) {
      const body = await this.readErrorBody(response);
      if (response.status === 403 || response.status === 429) {
        if (this.rateRemaining === 0) {
          throw new Error(
            this.rateResetAt
              ? `GitHub 接口限额已用尽，${formatGithubTime(this.rateResetAt, this.timezone)} 后恢复`
              : 'GitHub 接口限额已用尽，请稍后重试',
          );
        }
        throw new Error(`GitHub 返回 ${response.status}${body ? `：${body}` : ''}`);
      }
      throw new Error(`GitHub 返回 ${response.status}${body ? `：${body}` : ''}`);
    }

    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('GitHub 响应格式不正确（不是事件数组）');

    const baseline = row.baseline_at === 0;
    const ageCutoff = now - this.cfg.maxEventAgeHours * 3600_000;
    const insert = this.store.db.prepare(
      `INSERT OR IGNORE INTO github_events(event_id,login,type,repo,summary,text,url,occurred_at,fetched_at,state)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    );
    let pending = 0;
    let newest = row.last_event_at;

    for (const item of body) {
      const event = parseGithubEvent(item);
      if (!event) continue;
      if (event.createdAt > newest) newest = event.createdAt;

      let state = 'pending';
      let summary = '';
      let text = '';
      let url = '';
      if (!(this.cfg.eventTypes as string[]).includes(event.type)) state = 'skipped';
      else if (baseline) state = 'skipped';
      else if (event.createdAt < ageCutoff) state = 'skipped';

      if (state === 'pending') {
        const rendered = renderGithubEvent(event, this.timezone);
        summary = rendered.summary;
        text = rendered.text;
        url = rendered.url;
      }

      const result = insert.run(
        event.id,
        event.login,
        event.type,
        event.repo,
        summary,
        text,
        url,
        event.createdAt,
        now,
        state,
      );
      if (Number(result.changes) > 0 && state === 'pending') pending++;
    }

    const etag = response.headers.get('etag') ?? '';
    this.store.db
      .prepare(
        'UPDATE github_authors SET etag=?, baseline_at=?, last_polled_at=?, last_event_at=?, last_error=? WHERE login=?',
      )
      .run(etag || row.etag, baseline ? now : row.baseline_at, now, newest, '', key);

    if (baseline) {
      this.log.info(
        { githubAuthor: author.login, events: body.length },
        '已建立 GitHub 作者基线：历史动态不推送，后续新动态开始追踪',
      );
    }
    return pending;
  }

  // ============================================================
  // 推送
  // ============================================================

  private async deliverPending(now: number): Promise<number> {
    if (!this.ready()) {
      if (this.countPending() > 0) this.log.debug('OneBot 未就绪，GitHub 动态保留到下次推送');
      return 0;
    }
    // 面板取消某类事件后，已经排队的同类型事件不再补发（保留记录，便于面板查看）
    const enabledTypes = new Set<string>(this.cfg.eventTypes);
    let delivered = 0;
    for (const author of this.cfg.authors.filter((a) => a.enabled)) {
      if (this.stopped) break;
      const rows = this.store.db
        .prepare(
          `SELECT * FROM github_events
           WHERE state='pending' AND lower(login)=?
           ORDER BY occurred_at ASC LIMIT ?`,
        )
        .all(author.login.toLowerCase(), this.cfg.maxEventsPerPoll) as unknown as EventRow[];
      for (const row of rows) {
        if (this.stopped) break;
        if (!enabledTypes.has(row.type)) {
          this.markEvent(row.event_id, 'skipped', '事件类型已在面板取消', row.attempts);
          continue;
        }
        if (!row.text) {
          this.markEvent(row.event_id, 'skipped', '事件正文为空', row.attempts);
          continue;
        }
        const outcome = await this.deliverEvent(row, now);
        if (outcome === 'sent') delivered++;
        if (outcome === 'offline') return delivered;
      }
    }
    return delivered;
  }

  private async deliverEvent(row: EventRow, now: number): Promise<'sent' | 'pending' | 'failed' | 'skipped' | 'offline'> {
    const targets = this.cfg.targets.filter((t) => t.enabled);
    if (targets.length === 0) {
      this.markEvent(row.event_id, 'skipped', '没有启用的推送会话', row.attempts);
      return 'skipped';
    }
    if (!this.ready()) return 'offline';

    let failed = 0;
    for (const target of targets) {
      if (this.alreadyDelivered(row.event_id, target.scope)) continue;
      try {
        // 必须用消息段数组：正文来自不可信文本，由 toCqCodes 做 CQ 转义
        const segments: ObMessageSegment[] = [{ type: 'text', data: { text: row.text } }];
        const sent = await this.sender.sendToScope(target.scope, segments, {
          throwOnError: true,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (!Number.isSafeInteger(sent.message_id) || sent.message_id <= 0) {
          throw new Error('投递回执没有可靠消息ID');
        }
        this.store.db
          .prepare(
            'INSERT INTO github_deliveries(event_id,scope,status,message_id,error,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(row.event_id, target.scope, 'sent', sent.message_id, '', now);
        this.recordHistory(target.scope, row.text, sent.message_id);
      } catch (e) {
        failed++;
        const message = cleanGithubText((e as Error).message, 300) || '发送失败';
        this.store.db
          .prepare(
            'INSERT INTO github_deliveries(event_id,scope,status,message_id,error,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(row.event_id, target.scope, 'failed', null, message, now);
        this.log.warn(
          { scope: target.scope, githubEvent: row.event_id, ...errorDetails(e), reason: message },
          'GitHub 动态推送失败',
        );
      }
    }

    if (failed === 0) {
      this.markEvent(row.event_id, 'sent', '', row.attempts);
      return 'sent';
    }
    const attempts = row.attempts + 1;
    if (attempts >= MAX_DELIVERY_ATTEMPTS || now - row.occurred_at > MAX_DELIVERY_AGE_MS) {
      this.markEvent(row.event_id, 'failed', `${failed} 个会话投递失败`, attempts);
      return 'failed';
    }
    this.markEvent(row.event_id, 'pending', `${failed} 个会话投递失败`, attempts);
    return 'pending';
  }

  /** 推送成功的事件记进会话历史，让机器人自己的上下文里也有这条消息 */
  private recordHistory(scope: string, text: string, messageId: number): void {
    try {
      const scopeType = scope.startsWith('group:') ? 'group' : 'private';
      const targetId = Number(scope.split(':')[1]);
      this.store.touchSession(scope, scopeType, targetId);
      this.store.addMessage({
        scope,
        userId: 0,
        role: 'assistant',
        content: text,
        messageId,
        senderName: 'GitHub 追踪',
      });
    } catch (e) {
      this.log.warn({ scope, ...errorDetails(e) }, 'GitHub 动态已发送，但写入会话历史失败');
    }
  }

  // ============================================================
  // 小工具
  // ============================================================

  private applyConfig(next: GithubConfig): void {
    const previous = this.cfg;
    this.cfg = next;

    // 作者被移除/暂停后，不再补发它遗留的待推送事件
    this.skipInactivePending();

    if (this.stopped) return;
    const turnedOn = !previous.enabled && next.enabled;
    const authorsChanged = !sameAuthors(previous.authors, next.authors);
    const targetsChanged = !sameTargets(previous.targets, next.targets);
    if (turnedOn || previous.intervalSec !== next.intervalSec) {
      this.scheduleNext(turnedOn ? 0 : next.intervalSec * 1000);
    } else if (next.enabled && (authorsChanged || targetsChanged)) {
      // 新加作者要尽快建立基线；新加/恢复推送会话要尽快补发积压事件。
      // 这里只提前一轮，不改写轮询间隔。
      this.scheduleNext(1_000);
    }
  }

  /** 把「作者已停用/移除」的待推送事件标记为 skipped */
  private skipInactivePending(): void {
    const activeKeys = this.cfg.authors.filter((a) => a.enabled).map((a) => a.login.toLowerCase());
    if (activeKeys.length > 0) {
      const placeholders = activeKeys.map(() => '?').join(',');
      this.store.db
        .prepare(
          `UPDATE github_events SET state='skipped', last_error=?
           WHERE state='pending' AND lower(login) NOT IN (${placeholders})`,
        )
        .run('作者已暂停或移除', ...activeKeys);
    } else {
      this.store.db
        .prepare("UPDATE github_events SET state='skipped', last_error=? WHERE state='pending'")
        .run('作者已暂停或移除');
    }
  }

  private authorRow(key: string): AuthorRow | undefined {
    return this.store.db.prepare('SELECT * FROM github_authors WHERE login=?').get(key) as AuthorRow | undefined;
  }

  private ensureAuthorRow(key: string): AuthorRow {
    const existing = this.authorRow(key);
    if (existing) return existing;
    this.store.db
      .prepare('INSERT OR IGNORE INTO github_authors(login,baseline_at,last_polled_at,last_event_at) VALUES(?,?,?,?)')
      .run(key, 0, 0, 0);
    return this.authorRow(key)!;
  }

  private markAuthorError(login: string, message: string): void {
    const key = login.toLowerCase();
    this.ensureAuthorRow(key);
    this.store.db
      .prepare('UPDATE github_authors SET last_error=?, last_polled_at=? WHERE login=?')
      .run(cleanGithubText(message, 300), this.now(), key);
  }

  private markEvent(eventId: string, state: string, error: string, attempts: number): void {
    this.store.db
      .prepare('UPDATE github_events SET state=?, last_error=?, attempts=? WHERE event_id=?')
      .run(state, cleanGithubText(error, 300), attempts, eventId);
  }

  private alreadyDelivered(eventId: string, scope: string): boolean {
    return Boolean(
      this.store.db
        .prepare("SELECT 1 AS hit FROM github_deliveries WHERE event_id=? AND scope=? AND status='sent' LIMIT 1")
        .get(eventId, scope),
    );
  }

  private countPending(): number {
    const row = this.store.db.prepare("SELECT COUNT(*) AS n FROM github_events WHERE state='pending'").get() as
      | { n: number }
      | undefined;
    return toNumber(row?.n);
  }

  private updateRate(headers: GithubHttpResponse['headers']): void {
    const limit = headerNumber(headers, 'x-ratelimit-limit');
    const remaining = headerNumber(headers, 'x-ratelimit-remaining');
    const reset = headerNumber(headers, 'x-ratelimit-reset');
    if (limit !== null) this.rateLimit = limit;
    if (remaining !== null) this.rateRemaining = remaining;
    if (reset !== null && reset > 0) this.rateResetAt = reset * 1000;
    if (remaining !== null) {
      this.rateBlockedUntil = remaining === 0 && this.rateResetAt ? this.rateResetAt + 1000 : 0;
    }
  }

  private async readErrorBody(response: GithubHttpResponse): Promise<string> {
    try {
      return cleanGithubText((await response.text()).slice(0, 300), 200);
    } catch {
      return '';
    }
  }

  private prune(now: number): void {
    const cutoff = now - HISTORY_RETENTION_DAYS * 86400_000;
    this.store.db.prepare("DELETE FROM github_events WHERE state <> 'pending' AND fetched_at < ?").run(cutoff);
    this.store.db.prepare('DELETE FROM github_deliveries WHERE created_at < ?').run(cutoff);
  }
}
