/**
 * GitHub 动态追踪器
 *
 * 支持两种模式（config/github.yaml 的 mode）：
 *   - authors：轮询作者的公开事件（/users/{login}/events/public）
 *   - repos：订阅指定仓库，按分支比对 HEAD SHA（/repos/{owner}/{repo}/commits），
 *            并轮询 Release（/releases）；不依赖 events 的缓存，更即时
 *   - both：两者同时
 *
 * 首次成功轮询只建立基线（作者历史事件、仓库当前 HEAD/最新 Release 记为 skipped），
 * 不推送历史；之后的新事件写入 github_events，按 occurred_at 顺序推送。
 *
 * 推送目标是**本功能页自己配置的会话**（config/github.yaml 的 targets），
 * 完全不走 trigger 里的群/用户白名单。
 * OneBot 离线或某个会话发送失败时保留 pending，下轮补发；超过重试上限/48 小时转 failed。
 *
 * 去重与重试都落 SQLite（github_events / github_deliveries / github_authors / github_repos），
 * 重启不会把同一批事件再发一遍。
 */
import type { Logger } from '../core/logger.js';
import { errorDetails } from '../core/logger.js';
import type { ObMessageSegment } from '../core/types.js';
import type { MemoryStore } from '../memory/store.js';
import {
  GITHUB_EVENT_LABELS,
  GITHUB_EVENT_TYPES,
  GITHUB_REPO_PUSH_TYPE,
  GITHUB_REPO_RELEASE_TYPE,
  publicGithubConfig,
  saveGithubConfig,
  validateGithubConfig,
  type GithubAuthorConfig,
  type GithubConfig,
  type GithubRepoConfig,
  type GithubTargetConfig,
  type PublicGithubConfig,
} from './config.js';
import {
  cleanGithubText,
  formatGithubTime,
  parseGithubEvent,
  renderGithubEvent,
  renderGithubTestMessage,
  renderRepoPush,
  renderRepoRelease,
  safeGithubUrl,
  type GithubEventDto,
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

export interface GithubSummaryCommit {
  sha: string;
  author: string;
  message: string;
}

/** 交给 AI 总结的原始更新数据（提交信息/发布说明均来自 GitHub，属于不可信文本） */
export interface GithubSummaryInput {
  kind: 'push' | 'release';
  repo: string;
  branch: string;
  /** 本次变更的总提交数；commits 可能只包含用于摘要的前几条 */
  total?: number;
  commits?: GithubSummaryCommit[];
  release?: {
    tag: string;
    name: string;
    body: string;
    prerelease: boolean;
  };
}

export type GithubSummarizer = (input: GithubSummaryInput) => Promise<string>;

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
  /** 可选：调用摘要模型生成 AI 总结；失败时不影响原始消息发送 */
  summarize?: GithubSummarizer;
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
  repoCount: number;
  reposSyncedAt: number;
  repoError: string;
}

export interface GithubAuthorRepoView {
  login: string;
  repo: string;
  branch: string;
  releases: boolean;
  baselineAt: number;
  headSha: string;
  lastPolledAt: number;
  lastError: string;
  pending: number;
}

export interface GithubRepoView {
  repo: string;
  branch: string;
  releases: boolean;
  enabled: boolean;
  baselineAt: number;
  headSha: string;
  lastPolledAt: number;
  lastError: string;
  releaseTag: string;
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
  authorRepos: GithubAuthorRepoView[];
  repos: GithubRepoView[];
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
  repos_synced_at: number;
  repo_error: string;
}

interface RepoSub {
  repo: string;
  branch: string;
  releases: boolean;
  enabled: boolean;
  sources: string[];
}

interface RepoRow {
  repo: string;
  branch: string;
  head_sha: string;
  baseline_at: number;
  release_id: number;
  release_tag: string;
  release_baseline_at: number;
  last_polled_at: number;
  last_error: string;
}

interface RepoCommit {
  sha: string;
  author: string;
  message: string;
  date: number;
  url: string;
}

interface RepoReleaseData {
  id: number;
  tag: string;
  name: string;
  body: string;
  prerelease: boolean;
  url: string;
  publishedAt: number;
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
  dedupe_key: string;
}

/** 单次 HTTP 请求上限；GitHub 正常响应远快于此 */
const REQUEST_TIMEOUT_MS = 15000;
/** 每个事件最多重试轮数，超过转 failed，避免永久占用队列 */
const MAX_DELIVERY_ATTEMPTS = 3;
/** 事件超过这个年龄就不再补发 */
const MAX_DELIVERY_AGE_MS = 48 * 3600_000;
/** 已完成/已跳过记录的保留天数 */
const HISTORY_RETENTION_DAYS = 30;
/** 仓库订阅每轮拉取的提交数；通常只需前几条就能找到上一次的 HEAD */
const REPO_COMMIT_PAGE_SIZE = 50;
/** 仓库订阅每轮拉取的 Release 数 */
const REPO_RELEASE_PAGE_SIZE = 10;

function headerNumber(headers: GithubHttpResponse['headers'], name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function parseDate(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function repoPath(repo: string): string {
  return repo.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function repoOwner(repo: string): string {
  return repo.split('/')[0] ?? '';
}

function shortSha(sha: string): string {
  return cleanGithubText(sha, 40).slice(0, 7);
}

/** 作者公开事件与仓库订阅重叠时的去重键；其他事件不参与跨源去重 */
function authorDedupeKey(event: GithubEventDto): string {
  const repo = event.repo.trim().toLowerCase();
  if (!repo) return '';
  if (event.type === 'PushEvent') {
    const head = event.payload['head'];
    if (typeof head === 'string' && head.trim() && !/^0+$/.test(head.trim())) {
      return `push:${repo}:${head.trim().toLowerCase()}`;
    }
    return '';
  }
  if (event.type === 'ReleaseEvent') {
    const release = event.payload['release'];
    if (typeof release === 'object' && release !== null && !Array.isArray(release)) {
      const record = release as Record<string, unknown>;
      const id = toNumber(record['id']);
      if (id > 0) return `release:${repo}:${id}`;
      const tag = record['tag_name'];
      if (typeof tag === 'string' && tag.trim()) return `release:${repo}:${tag.trim().toLowerCase()}`;
    }
  }
  return '';
}

function isRepoEventType(type: string): boolean {
  return type === GITHUB_REPO_PUSH_TYPE || type === GITHUB_REPO_RELEASE_TYPE;
}

function repoCommitInfo(raw: unknown): RepoCommit | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const sha = typeof item['sha'] === 'string' ? item['sha'].trim() : '';
  if (!sha) return null;
  const commit = item['commit'];
  let message = '';
  let authorName = '';
  let date = 0;
  if (typeof commit === 'object' && commit !== null && !Array.isArray(commit)) {
    const c = commit as Record<string, unknown>;
    message = typeof c['message'] === 'string' ? c['message'] : '';
    const author = c['author'];
    if (typeof author === 'object' && author !== null && !Array.isArray(author)) {
      const a = author as Record<string, unknown>;
      authorName = typeof a['name'] === 'string' ? a['name'] : '';
      date = parseDate(a['date']);
    }
  }
  const actor = item['author'];
  const login =
    typeof actor === 'object' && actor !== null && !Array.isArray(actor) && typeof (actor as Record<string, unknown>)['login'] === 'string'
      ? String((actor as Record<string, unknown>)['login'])
      : '';
  return {
    sha,
    author: login || authorName || '未知作者',
    message,
    date,
    url: safeGithubUrl(item['html_url']),
  };
}

function repoReleaseData(raw: unknown): RepoReleaseData | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id = toNumber(item['id']);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (item['draft'] === true) return null;
  const tag = typeof item['tag_name'] === 'string' ? item['tag_name'] : '';
  const name = typeof item['name'] === 'string' ? item['name'] : '';
  const body = typeof item['body'] === 'string' ? item['body'] : '';
  const prerelease = item['prerelease'] === true;
  const url = safeGithubUrl(item['html_url']);
  const publishedAt =
    parseDate(item['published_at']) || parseDate(item['created_at']) || Date.now();
  return { id, tag, name, body, prerelease, url, publishedAt };
}

/** 作者列表是否只是同一批人（用户名大小写不敏感），用于判断保存后要不要立刻补一轮 */
function sameAuthors(a: GithubAuthorConfig[], b: GithubAuthorConfig[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index]!;
    return item.login.toLowerCase() === other.login.toLowerCase() && item.enabled === other.enabled;
  });
}

/** 订阅仓库列表是否只是同一批配置 */
function sameRepos(a: GithubRepoConfig[], b: GithubRepoConfig[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index]!;
    return (
      item.repo.toLowerCase() === other.repo.toLowerCase() &&
      item.branch === other.branch &&
      item.releases === other.releases &&
      item.enabled === other.enabled
    );
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
  private readonly summarizeImpl?: GithubSummarizer;

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
    this.summarizeImpl = opts.summarize;
    this.store.onClose(() => {
      void this.stop();
    });
    // 旧版本把「动作成功但没有可靠 message_id」当成失败，导致已发出的消息一直 pending。
    // 修复历史记录，并把所有启用会话都已成功的 pending/failed 事件对齐为 sent。
    this.repairAmbiguousDeliveries();
    this.reconcileDeliveredEvents();
    // 作者已从配置移除/暂停时，连同它名下的自动仓库一起取消
    this.pruneInactiveAuthorRepos();
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
      {
        enabled: result.config.enabled,
        mode: result.config.mode,
        tokenSet: result.config.token.length > 0,
        repoDiscoverySec: result.config.repoDiscoverySec,
        authors: result.config.authors.length,
        repos: result.config.repos.length,
        targets: result.config.targets.length,
      },
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
            `SELECT lower(login) AS key, COUNT(*) AS total,
                    SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending
             FROM github_events
             WHERE type NOT IN (?,?)
             GROUP BY lower(login)`,
          )
          .all(GITHUB_REPO_PUSH_TYPE, GITHUB_REPO_RELEASE_TYPE) as unknown as Array<{
            key: string;
            total: number;
            pending: number | null;
          }>
      ).map((row) => [row.key, { total: toNumber(row.total), pending: toNumber(row.pending) }]),
    );
    const authorRepoRows = this.store.db
      .prepare('SELECT login,repo FROM github_author_repos ORDER BY login,repo')
      .all() as unknown as Array<{ login: string; repo: string }>;
    const authorRepoCounts = new Map<string, number>();
    for (const row of authorRepoRows) {
      const key = row.login.toLowerCase();
      authorRepoCounts.set(key, (authorRepoCounts.get(key) ?? 0) + 1);
    }
    const authorNames = new Map(this.cfg.authors.map((author) => [author.login.toLowerCase(), author.login]));
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
        repoCount: authorRepoCounts.get(key) ?? 0,
        reposSyncedAt: row?.repos_synced_at ?? 0,
        repoError: row?.repo_error ?? '',
      };
    });

    const repoStats = new Map(
      (
        this.store.db
          .prepare(
            `SELECT lower(repo) AS key, COUNT(*) AS total,
                    SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending
             FROM github_events
             WHERE type IN (?,?)
             GROUP BY lower(repo)`,
          )
          .all(GITHUB_REPO_PUSH_TYPE, GITHUB_REPO_RELEASE_TYPE) as unknown as Array<{
            key: string;
            total: number;
            pending: number | null;
          }>
      ).map((row) => [row.key, { total: toNumber(row.total), pending: toNumber(row.pending) }]),
    );
    const repos: GithubRepoView[] = this.cfg.repos.map((repo) => {
      const key = repo.repo.toLowerCase();
      const row = this.repoRow(key);
      const stat = repoStats.get(key);
      return {
        repo: repo.repo,
        branch: repo.branch,
        releases: repo.releases,
        enabled: repo.enabled,
        baselineAt: row?.baseline_at ?? 0,
        headSha: row?.head_sha ?? '',
        lastPolledAt: row?.last_polled_at ?? 0,
        lastError: row?.last_error ?? '',
        releaseTag: row?.release_tag ?? '',
        total: stat?.total ?? 0,
        pending: stat?.pending ?? 0,
      };
    });

    const authorRepos: GithubAuthorRepoView[] = authorRepoRows.map((entry) => {
      const key = entry.repo.toLowerCase();
      const row = this.repoRow(key);
      const stat = repoStats.get(key);
      const manual = this.cfg.repos.find((repo) => repo.repo.toLowerCase() === key);
      return {
        login: authorNames.get(entry.login.toLowerCase()) ?? entry.login,
        repo: entry.repo,
        branch: manual?.branch ?? '',
        releases: true,
        baselineAt: row?.baseline_at ?? 0,
        headSha: row?.head_sha ?? '',
        lastPolledAt: row?.last_polled_at ?? 0,
        lastError: row?.last_error ?? '',
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
      authorRepos,
      repos,
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
      if (this.tracksAuthors()) {
        for (const author of this.cfg.authors.filter((a) => a.enabled)) {
          if (this.stopped) break;
          try {
            // 公开仓库发现频率与事件轮询独立：默认 3 小时，手动「立即检查」强制刷新
            await this.syncAuthorRepos(author, startedAt, reason === 'manual');
          } catch (e) {
            const message = cleanGithubText((e as Error).message, 300) || '未知错误';
            errors.push(`${author.login} 公开仓库发现：${message}`);
            this.log.warn(
              { githubAuthor: author.login, ...errorDetails(e), reason: message },
              'GitHub 作者公开仓库发现失败',
            );
          }
          if (this.stopped || this.rateRemaining === 0) break;
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

      const repoSubs = this.activeRepoSubs();
      if (repoSubs.length > 0 && this.rateRemaining !== 0) {
        for (const repo of repoSubs) {
          if (this.stopped || this.rateRemaining === 0) break;
          try {
            fetched += await this.pollRepoCommits(repo, startedAt);
          } catch (e) {
            const message = cleanGithubText((e as Error).message, 300) || '未知错误';
            this.markRepoError(repo.repo, message);
            errors.push(`${repo.repo}：${message}`);
            this.log.warn(
              { githubRepo: repo.repo, ...errorDetails(e), reason: message },
              'GitHub 仓库提交拉取失败',
            );
          }
          if (this.rateRemaining === 0) break;
          if (!repo.releases) continue;
          try {
            fetched += await this.pollRepoReleases(repo, startedAt);
          } catch (e) {
            const message = cleanGithubText((e as Error).message, 300) || '未知错误';
            this.markRepoError(repo.repo, message);
            errors.push(`${repo.repo} Release：${message}`);
            this.log.warn(
              { githubRepo: repo.repo, ...errorDetails(e), reason: message },
              'GitHub 仓库 Release 拉取失败',
            );
          }
        }
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
    const headers = this.apiHeaders();
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
      `INSERT OR IGNORE INTO github_events(event_id,login,type,repo,summary,text,url,occurred_at,fetched_at,state,dedupe_key)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    );
    let pending = 0;
    let newest = row.last_event_at;

    for (const item of body) {
      const event = parseGithubEvent(item);
      if (!event) continue;
      if (event.createdAt > newest) newest = event.createdAt;

      // 作者公开事件与仓库订阅可能描述同一次 push/release：已有任意一条时跳过作者事件。
      // 若作者事件先入库，仓库订阅随后会把它升级成更完整的 RepoPush/RepoRelease。
      const dedupeKey = authorDedupeKey(event);
      if (dedupeKey && this.findByDedupe(dedupeKey)) continue;

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
        dedupeKey,
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

  private tracksAuthors(): boolean {
    return this.cfg.mode === 'authors' || this.cfg.mode === 'both';
  }

  private tracksRepos(): boolean {
    return this.cfg.mode === 'repos' || this.cfg.mode === 'both';
  }

  /**
   * 实际参与轮询的仓库 = 手动订阅（repos 模式）+ 作者公开仓库（authors 模式）。
   * 同一个仓库两边都有时合并成一份，手动配置优先，来源同时记录。
   */
  private activeRepoSubs(): RepoSub[] {
    const map = new Map<string, RepoSub>();
    if (this.tracksRepos()) {
      for (const repo of this.cfg.repos) {
        map.set(repo.repo.toLowerCase(), {
          repo: repo.repo,
          branch: repo.branch,
          releases: repo.releases,
          enabled: repo.enabled,
          sources: ['manual'],
        });
      }
    }
    if (this.tracksAuthors()) {
      const logins = this.cfg.authors.filter((a) => a.enabled).map((a) => a.login.toLowerCase());
      if (logins.length > 0) {
        const placeholders = logins.map(() => '?').join(',');
        const rows = this.store.db
          .prepare(`SELECT login,repo FROM github_author_repos WHERE lower(login) IN (${placeholders})`)
          .all(...logins) as unknown as Array<{ login: string; repo: string }>;
        for (const row of rows) {
          const key = row.repo.toLowerCase();
          const existing = map.get(key);
          if (existing) {
            // 作者追踪强制覆盖暂停/关闭 Release 的手动设置：作者仓库必须同时追踪 Release
            existing.enabled = true;
            existing.releases = true;
            existing.sources.push(`author:${row.login}`);
          } else {
            map.set(key, {
              repo: row.repo,
              branch: '',
              releases: true,
              enabled: true,
              sources: [`author:${row.login}`],
            });
          }
        }
      }
    }
    return [...map.values()].filter((repo) => repo.enabled);
  }

  /** 作者被移除/暂停/模式切走后，删除其自动仓库映射；没有手动订阅的仓库连状态一起清理 */
  private pruneInactiveAuthorRepos(): void {
    const active = this.tracksAuthors()
      ? this.cfg.authors.filter((a) => a.enabled).map((a) => a.login.toLowerCase())
      : [];
    let removed: Array<{ login: string; repo: string }>;
    if (active.length > 0) {
      const placeholders = active.map(() => '?').join(',');
      removed = this.store.db
        .prepare(`SELECT login,repo FROM github_author_repos WHERE lower(login) NOT IN (${placeholders})`)
        .all(...active) as unknown as Array<{ login: string; repo: string }>;
      this.store.db
        .prepare(`DELETE FROM github_author_repos WHERE lower(login) NOT IN (${placeholders})`)
        .run(...active);
      this.store.db
        .prepare(`UPDATE github_authors SET repos_synced_at=0 WHERE lower(login) NOT IN (${placeholders})`)
        .run(...active);
    } else {
      removed = this.store.db
        .prepare('SELECT login,repo FROM github_author_repos')
        .all() as unknown as Array<{ login: string; repo: string }>;
      this.store.db.exec('DELETE FROM github_author_repos; UPDATE github_authors SET repos_synced_at=0');
    }
    const seen = new Set<string>();
    for (const row of removed) {
      const key = row.repo.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      this.cleanupAuthorRepo(key);
    }
  }

  /** 仓库不再由任何作者/手动订阅引用时，清掉 HEAD 状态并跳过待推送事件 */
  private cleanupAuthorRepo(key: string): void {
    if (this.cfg.repos.some((repo) => repo.repo.toLowerCase() === key)) return;
    const other = this.store.db
      .prepare('SELECT 1 AS hit FROM github_author_repos WHERE lower(repo)=? LIMIT 1')
      .get(key);
    if (other) return;
    this.store.db.prepare('DELETE FROM github_repos WHERE repo=?').run(key);
    this.store.db
      .prepare(
        `UPDATE github_events SET state='skipped', last_error=?
         WHERE state='pending' AND type IN (?,?) AND lower(repo)=?`,
      )
      .run('作者仓库已取消', GITHUB_REPO_PUSH_TYPE, GITHUB_REPO_RELEASE_TYPE, key);
  }

  /** 发现作者的所有公开仓库；默认每 repoDiscoverySec 秒一次，手动检查可强制刷新 */
  private async syncAuthorRepos(author: GithubAuthorConfig, now: number, force: boolean): Promise<void> {
    const key = author.login.toLowerCase();
    const row = this.ensureAuthorRow(key);
    if (
      !force &&
      row.repos_synced_at > 0 &&
      now - row.repos_synced_at < this.cfg.repoDiscoverySec * 1000
    ) {
      return;
    }
    try {
      const repos = await this.fetchAuthorRepos(author.login);
      const db = this.store.db;
      const removed: string[] = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db
          .prepare('SELECT repo FROM github_author_repos WHERE login=?')
          .all(key) as unknown as Array<{ repo: string }>;
        const existingKeys = new Set(existing.map((item) => item.repo.toLowerCase()));
        const discovered = new Set<string>();
        const insert = db.prepare('INSERT OR IGNORE INTO github_author_repos(login,repo) VALUES(?,?)');
        for (const repo of repos) {
          const repoKey = repo.toLowerCase();
          if (discovered.has(repoKey)) continue;
          discovered.add(repoKey);
          if (!existingKeys.has(repoKey)) insert.run(key, repo);
        }
        const remove = db.prepare('DELETE FROM github_author_repos WHERE login=? AND lower(repo)=?');
        for (const old of existing) {
          const repoKey = old.repo.toLowerCase();
          if (!discovered.has(repoKey)) {
            removed.push(repoKey);
            remove.run(key, repoKey);
          }
        }
        db.prepare('UPDATE github_authors SET repos_synced_at=?, repo_error=? WHERE login=?').run(now, '', key);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      for (const repoKey of removed) this.cleanupAuthorRepo(repoKey);
      if (removed.length > 0) this.skipInactivePending();
      this.log.info(
        { githubAuthor: author.login, publicRepos: repos.length, removed: removed.length },
        '已同步作者公开仓库',
      );
    } catch (e) {
      const message = cleanGithubText((e as Error).message, 300) || '未知错误';
      this.store.db
        .prepare('UPDATE github_authors SET repos_synced_at=?, repo_error=? WHERE login=?')
        .run(now, message, key);
      throw e;
    }
  }

  private async fetchAuthorRepos(login: string): Promise<string[]> {
    const found = new Set<string>();
    for (let page = 1; ; page++) {
      const url = `${this.cfg.apiBase}/users/${encodeURIComponent(login)}/repos?type=owner&per_page=100&page=${page}`;
      const response = await this.fetchImpl(url, {
        headers: this.apiHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      this.updateRate(response.headers);
      if (response.status === 404) throw new Error('GitHub 用户不存在或已改名');
      if (!response.ok) throw new Error(await this.githubFailure(response));
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error('GitHub 公开仓库响应格式不正确');
      for (const item of body) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (record['private'] === true) continue;
        // 空仓库没有可比较的提交，跳过；缺少 size 字段时仍按公开仓库处理
        if (typeof record['size'] === 'number' && record['size'] === 0) continue;
        const fullName = typeof record['full_name'] === 'string' ? record['full_name'].trim() : '';
        if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) continue;
        found.add(fullName);
      }
      if (body.length < 100) break;
      if (this.rateRemaining === 0) {
        throw new Error(
          this.rateResetAt
            ? `GitHub 接口限额已用尽，${formatGithubTime(this.rateResetAt, this.timezone)} 后恢复`
            : 'GitHub 接口限额已用尽，请稍后重试',
        );
      }
    }
    return [...found];
  }

  private apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'qq-agent-github-tracker',
      'x-github-api-version': '2022-11-28',
    };
    if (this.cfg.token) headers['authorization'] = `Bearer ${this.cfg.token}`;
    return headers;
  }

  /** 统一把非 2xx 响应转成中文错误；403/429 且剩余为 0 时给出重置时间 */
  private async githubFailure(response: GithubHttpResponse): Promise<string> {
    const body = await this.readErrorBody(response);
    if (response.status === 401) return 'GitHub Token 无效或已过期，请重新填写';
    if (response.status === 404) return '仓库或分支不存在，或 Token 无权访问';
    if ((response.status === 403 || response.status === 429) && this.rateRemaining === 0) {
      return this.rateResetAt
        ? `GitHub 接口限额已用尽，${formatGithubTime(this.rateResetAt, this.timezone)} 后恢复`
        : 'GitHub 接口限额已用尽，请稍后重试';
    }
    return `GitHub 返回 ${response.status}${body ? `：${body}` : ''}`;
  }

  /** 调用摘要模型；关闭开关、未注入实现或失败时返回空串，不影响原始消息 */
  private async summarize(input: GithubSummaryInput): Promise<string> {
    if (!this.cfg.aiSummary || !this.summarizeImpl) return '';
    try {
      const text = await this.summarizeImpl(input);
      return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => cleanGithubText(line.replace(/^\s*[-*•]\s*/, ''), 120))
        .filter(Boolean)
        .slice(0, 4)
        .join('\n');
    } catch (e) {
      this.log.warn({ githubRepo: input.repo, ...errorDetails(e) }, 'GitHub 更新 AI 总结失败，保留原始消息');
      return '';
    }
  }

  private eventExists(eventId: string): boolean {
    return Boolean(
      this.store.db.prepare('SELECT 1 AS hit FROM github_events WHERE event_id=? LIMIT 1').get(eventId),
    );
  }

  private findByDedupe(dedupeKey: string): EventRow | undefined {
    if (!dedupeKey) return undefined;
    return this.store.db
      .prepare('SELECT * FROM github_events WHERE dedupe_key=? LIMIT 1')
      .get(dedupeKey) as EventRow | undefined;
  }

  private hasSentDelivery(eventId: string): boolean {
    return Boolean(
      this.store.db
        .prepare("SELECT 1 AS hit FROM github_deliveries WHERE event_id=? AND status='sent' LIMIT 1")
        .get(eventId),
    );
  }

  /** 仓库事件是否已被作者事件/仓库事件抢先完成，避免白跑一次摘要模型 */
  private repoEventIsDuplicate(dedupeKey: string): boolean {
    const existing = this.findByDedupe(dedupeKey);
    if (!existing) return false;
    if (isRepoEventType(existing.type)) return true;
    if (existing.state === 'sent') return true;
    return this.hasSentDelivery(existing.event_id);
  }

  // ============================================================
  // 仓库订阅：commits / releases
  // ============================================================

  private async pollRepoCommits(repo: GithubRepoConfig, now: number): Promise<number> {
    const key = repo.repo.toLowerCase();
    const row = this.ensureRepoRow(key);
    const branchQuery = repo.branch ? `&sha=${encodeURIComponent(repo.branch)}` : '';
    const requestUrl = `${this.cfg.apiBase}/repos/${repoPath(repo.repo)}/commits?per_page=${REPO_COMMIT_PAGE_SIZE}${branchQuery}`;
    const response = await this.fetchImpl(requestUrl, {
      headers: this.apiHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.updateRate(response.headers);
    if (!response.ok) throw new Error(await this.githubFailure(response));

    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('GitHub 响应格式不正确（不是提交数组）');
    const commits = body
      .map(repoCommitInfo)
      .filter((item): item is RepoCommit => item !== null);
    const head = commits[0];
    if (!head) throw new Error('仓库没有可读取的提交（分支可能为空）');

    // 分支被修改（或首次以指定分支订阅）时，旧分支的 HEAD 不能用来比较，
    // 直接以新分支当前 HEAD 重建基线，避免把整段历史当成“新提交”。
    if (row.branch !== repo.branch) {
      this.store.db
        .prepare(
          'UPDATE github_repos SET head_sha=?, branch=?, baseline_at=?, last_polled_at=?, last_error=? WHERE repo=?',
        )
        .run(head.sha, repo.branch, now, now, '', key);
      this.log.info(
        { githubRepo: repo.repo, branch: repo.branch || '默认分支', headSha: shortSha(head.sha) },
        'GitHub 仓库分支已变更，重建 HEAD 基线',
      );
      return 0;
    }

    if (row.baseline_at === 0) {
      this.store.db
        .prepare(
          'UPDATE github_repos SET head_sha=?, branch=?, baseline_at=?, last_polled_at=?, last_error=? WHERE repo=?',
        )
        .run(head.sha, repo.branch, now, now, '', key);
      this.log.info(
        { githubRepo: repo.repo, headSha: shortSha(head.sha) },
        '已建立 GitHub 仓库基线：当前 HEAD 不推送，后续新提交开始追踪',
      );
      return 0;
    }

    if (head.sha === row.head_sha) {
      this.store.db
        .prepare('UPDATE github_repos SET last_polled_at=?, last_error=? WHERE repo=?')
        .run(now, '', key);
      return 0;
    }

    let fresh: RepoCommit[] = [];
    let total = 0;
    let rewritten = false;
    const oldIndex = commits.findIndex((item) => item.sha === row.head_sha);
    if (oldIndex > 0) {
      fresh = commits.slice(0, oldIndex);
      total = fresh.length;
    } else if (oldIndex === 0) {
      // 理论上不会走到：oldIndex=0 说明旧 HEAD 就是当前 HEAD
      fresh = [head];
      total = 1;
    } else {
      const compared = await this.compareRepoCommits(repo, row.head_sha, head.sha, head);
      fresh = compared.commits;
      total = compared.total;
      rewritten = compared.rewritten;
    }

    if (fresh.length === 0) {
      this.store.db
        .prepare('UPDATE github_repos SET head_sha=?, last_polled_at=?, last_error=? WHERE repo=?')
        .run(head.sha, now, '', key);
      return 0;
    }

    const branchLabel = repo.branch || '默认分支';
    const url =
      total > 1
        ? `https://github.com/${repo.repo}/compare/${row.head_sha}...${head.sha}`
        : fresh[0]!.url || head.url || `https://github.com/${repo.repo}/commit/${head.sha}`;
    const occurredAt = Math.max(...fresh.map((item) => item.date), head.date) || now;
    const commitInfos = fresh.map((item) => ({ sha: item.sha, author: item.author, message: item.message }));
    const eventId = `repo-push:${key}:${head.sha}`;
    const dedupeKey = `push:${key}:${head.sha.toLowerCase()}`;
    const existing = this.eventExists(eventId);
    const duplicate = existing || this.repoEventIsDuplicate(dedupeKey);
    const aiSummary = duplicate
      ? ''
      : await this.summarize({
          kind: 'push',
          repo: repo.repo,
          branch: branchLabel,
          total,
          commits: commitInfos,
        });
    const rendered = renderRepoPush(
      {
        repo: repo.repo,
        branch: branchLabel,
        total,
        commits: commitInfos,
        url,
        occurredAt,
      },
      this.timezone,
      aiSummary,
    );
    if (rewritten) {
      const note = '\n· 历史被重写或变更过多，按当前分支最新提交汇总';
      const marker = '\n🤖 AI 总结';
      const index = rendered.text.indexOf(marker);
      rendered.text = index >= 0 ? rendered.text.slice(0, index) + note + rendered.text.slice(index) : rendered.text + note;
    }

    const inserted = this.insertRepoEvent(
      eventId,
      repoOwner(repo.repo),
      GITHUB_REPO_PUSH_TYPE,
      repo.repo,
      rendered,
      occurredAt,
      now,
      dedupeKey,
    );
    this.store.db
      .prepare('UPDATE github_repos SET head_sha=?, last_polled_at=?, last_error=? WHERE repo=?')
      .run(head.sha, now, '', key);
    if (inserted > 0) {
      this.log.info(
        { githubRepo: repo.repo, commits: total, headSha: shortSha(head.sha) },
        '发现 GitHub 仓库新提交',
      );
    }
    return inserted;
  }

  /**
   * 上一次 HEAD 不在最近 50 条提交里（一次性推了很多，或历史被重写）。
   * 先试 compare 拿到准确的提交数；失败则退回最新一条并标记 rewritten。
   */
  private async compareRepoCommits(
    repo: GithubRepoConfig,
    oldSha: string,
    newSha: string,
    head: RepoCommit,
  ): Promise<{ commits: RepoCommit[]; total: number; rewritten: boolean }> {
    const url = `${this.cfg.apiBase}/repos/${repoPath(repo.repo)}/compare/${oldSha}...${newSha}`;
    const response = await this.fetchImpl(url, {
      headers: this.apiHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.updateRate(response.headers);
    if (response.status === 403 || response.status === 429) {
      throw new Error(await this.githubFailure(response));
    }
    if (response.ok) {
      const data: unknown = await response.json();
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        const record = data as Record<string, unknown>;
        const raw = Array.isArray(record['commits']) ? record['commits'] : [];
        const commits = raw.map(repoCommitInfo).filter((item): item is RepoCommit => item !== null);
        const total = toNumber(record['total_commits']) || commits.length;
        if (commits.length > 0) return { commits, total, rewritten: false };
      }
    }
    return { commits: [head], total: 1, rewritten: true };
  }

  private async pollRepoReleases(repo: GithubRepoConfig, now: number): Promise<number> {
    const key = repo.repo.toLowerCase();
    const row = this.ensureRepoRow(key);
    const requestUrl = `${this.cfg.apiBase}/repos/${repoPath(repo.repo)}/releases?per_page=${REPO_RELEASE_PAGE_SIZE}`;
    const response = await this.fetchImpl(requestUrl, {
      headers: this.apiHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.updateRate(response.headers);
    if (!response.ok) throw new Error(await this.githubFailure(response));

    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('GitHub 响应格式不正确（不是 Release 数组）');
    const releases = body
      .map(repoReleaseData)
      .filter((item): item is RepoReleaseData => item !== null);

    if (row.release_baseline_at === 0) {
      let maxId = 0;
      let tag = '';
      for (const release of releases) {
        if (release.id > maxId) {
          maxId = release.id;
          tag = release.tag;
        }
      }
      this.store.db
        .prepare(
          'UPDATE github_repos SET release_id=?, release_tag=?, release_baseline_at=?, last_polled_at=?, last_error=? WHERE repo=?',
        )
        .run(maxId, tag, now, now, '', key);
      this.log.info(
        { githubRepo: repo.repo, release: tag || '（暂无 Release）' },
        '已建立 GitHub 仓库 Release 基线：历史版本不推送',
      );
      return 0;
    }

    const fresh = releases
      .filter((release) => release.id > row.release_id)
      .sort((a, b) => a.id - b.id);
    if (fresh.length === 0) {
      this.store.db
        .prepare('UPDATE github_repos SET last_polled_at=?, last_error=? WHERE repo=?')
        .run(now, '', key);
      return 0;
    }

    let pending = 0;
    let lastId = row.release_id;
    let lastTag = row.release_tag;
    for (const release of fresh.slice(0, this.cfg.maxEventsPerPoll)) {
      const eventId = `repo-release:${key}:${release.id}`;
      const dedupeKey = `release:${key}:${release.id}`;
      const existing = this.eventExists(eventId);
      const duplicate = existing || this.repoEventIsDuplicate(dedupeKey);
      const aiSummary = duplicate
        ? ''
        : await this.summarize({
            kind: 'release',
            repo: repo.repo,
            branch: repo.branch || '默认分支',
            release: {
              tag: release.tag,
              name: release.name,
              body: release.body,
              prerelease: release.prerelease,
            },
          });
      const rendered = renderRepoRelease(
        repo.repo,
        {
          tag: release.tag,
          name: release.name,
          body: release.body,
          prerelease: release.prerelease,
          url: release.url,
          publishedAt: release.publishedAt,
        },
        this.timezone,
        aiSummary,
      );
      const inserted = this.insertRepoEvent(
        eventId,
        repoOwner(repo.repo),
        GITHUB_REPO_RELEASE_TYPE,
        repo.repo,
        rendered,
        release.publishedAt,
        now,
        dedupeKey,
      );
      pending += inserted;
      lastId = release.id;
      lastTag = release.tag;
    }
    this.store.db
      .prepare('UPDATE github_repos SET release_id=?, release_tag=?, last_polled_at=?, last_error=? WHERE repo=?')
      .run(lastId, lastTag, now, '', key);
    if (pending > 0) {
      this.log.info({ githubRepo: repo.repo, releases: pending, tag: lastTag }, '发现 GitHub 仓库新 Release');
    }
    return pending;
  }

  private insertRepoEvent(
    eventId: string,
    login: string,
    type: string,
    repo: string,
    rendered: { summary: string; text: string; url: string },
    occurredAt: number,
    now: number,
    dedupeKey: string,
  ): number {
    const existing = this.findByDedupe(dedupeKey);
    if (existing) {
      // 已由仓库订阅处理过，或作者事件已经实际发送：先发送者优先，不再重复。
      if (isRepoEventType(existing.type) || existing.state === 'sent' || this.hasSentDelivery(existing.event_id)) {
        return 0;
      }
      // 作者事件仍待推送/失败/跳过时，把它升级为更完整的仓库订阅消息。
      const updated = this.store.db
        .prepare(
          `UPDATE github_events
           SET login=?, type=?, repo=?, summary=?, text=?, url=?, occurred_at=?, fetched_at=?,
               state='pending', attempts=0, last_error=?, dedupe_key=?
           WHERE event_id=?`,
        )
        .run(
          login,
          type,
          repo,
          rendered.summary,
          rendered.text,
          rendered.url,
          occurredAt,
          now,
          '',
          dedupeKey,
          existing.event_id,
        );
      return Number(updated.changes) > 0 ? 1 : 0;
    }
    const result = this.store.db
      .prepare(
        `INSERT OR IGNORE INTO github_events(event_id,login,type,repo,summary,text,url,occurred_at,fetched_at,state,dedupe_key)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        eventId,
        login,
        type,
        repo,
        rendered.summary,
        rendered.text,
        rendered.url,
        occurredAt,
        now,
        'pending',
        dedupeKey,
      );
    return Number(result.changes);
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

    if (this.tracksAuthors()) {
      for (const author of this.cfg.authors.filter((a) => a.enabled)) {
        if (this.stopped) break;
        const rows = this.store.db
          .prepare(
            `SELECT * FROM github_events
             WHERE state='pending' AND lower(login)=? AND type NOT IN (?,?)
             ORDER BY occurred_at ASC LIMIT ?`,
          )
          .all(
            author.login.toLowerCase(),
            GITHUB_REPO_PUSH_TYPE,
            GITHUB_REPO_RELEASE_TYPE,
            this.cfg.maxEventsPerPoll,
          ) as unknown as EventRow[];
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
    }

    const repoSubs = this.activeRepoSubs();
    for (const repo of repoSubs) {
      if (this.stopped) break;
      const rows = this.store.db
        .prepare(
          `SELECT * FROM github_events
           WHERE state='pending' AND lower(repo)=? AND type IN (?,?)
           ORDER BY occurred_at ASC LIMIT ?`,
        )
        .all(
          repo.repo.toLowerCase(),
          GITHUB_REPO_PUSH_TYPE,
          GITHUB_REPO_RELEASE_TYPE,
          this.cfg.maxEventsPerPoll,
        ) as unknown as EventRow[];
      for (const row of rows) {
        if (this.stopped) break;
        if (row.type === GITHUB_REPO_RELEASE_TYPE && !repo.releases) {
          this.markEvent(row.event_id, 'skipped', '仓库已取消 Release 订阅', row.attempts);
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
        // 部分 OneBot/NapCat 版本动作成功但不返回可靠 message_id；消息已经发出，
        // 不能再按失败重试，否则会重复推送且面板一直显示“待推送”。
        const rawId = Number(sent.message_id);
        const messageId = Number.isSafeInteger(rawId) && rawId > 0 ? rawId : undefined;
        this.store.db
          .prepare(
            'INSERT INTO github_deliveries(event_id,scope,status,message_id,error,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(row.event_id, target.scope, 'sent', messageId ?? null, '', now);
        this.recordHistory(target.scope, row.text, messageId);
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
  private recordHistory(scope: string, text: string, messageId?: number): void {
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

  /** 修复旧版本“动作成功但无 message_id”被误记为失败的投递 */
  private repairAmbiguousDeliveries(): void {
    const result = this.store.db
      .prepare(
        "UPDATE github_deliveries SET status='sent', error='' WHERE status='failed' AND error='投递回执没有可靠消息ID'",
      )
      .run();
    const changed = Number(result.changes);
    if (changed > 0) {
      this.log.info({ deliveries: changed }, '已修复缺少回执 ID 但实际已发送的 GitHub 投递记录');
    }
  }

  /** 所有当前启用会话都已成功的事件，不应再停留在 pending/failed */
  private reconcileDeliveredEvents(): void {
    const scopes = this.cfg.targets.filter((target) => target.enabled).map((target) => target.scope);
    if (scopes.length === 0) return;
    const events = this.store.db
      .prepare("SELECT event_id FROM github_events WHERE state IN ('pending','failed')")
      .all() as unknown as Array<{ event_id: string }>;
    let changed = 0;
    const deliveryStmt = this.store.db.prepare(
      'SELECT scope,status FROM github_deliveries WHERE event_id=?',
    );
    for (const event of events) {
      const deliveries = deliveryStmt.all(event.event_id) as unknown as Array<{ scope: string; status: string }>;
      if (deliveries.length === 0) continue;
      const sentScopes = new Set(
        deliveries.filter((delivery) => delivery.status === 'sent').map((delivery) => delivery.scope),
      );
      // 当前没有启用会话时，退回到该事件已有的投递记录判断；
      // 避免用户关掉会话后，已经实际送达的事件仍显示待推送。
      const targetScopes = scopes.length > 0 ? scopes : [...new Set(deliveries.map((delivery) => delivery.scope))];
      if (targetScopes.length > 0 && targetScopes.every((scope) => sentScopes.has(scope))) {
        this.store.db
          .prepare("UPDATE github_events SET state='sent', last_error='', attempts=0 WHERE event_id=?")
          .run(event.event_id);
        changed++;
      }
    }
    if (changed > 0) {
      this.log.info({ events: changed }, '已对齐 GitHub 事件的已推送状态');
    }
  }

  // ============================================================
  // 小工具
  // ============================================================

  private applyConfig(next: GithubConfig): void {
    const previous = this.cfg;
    const authChanged = previous.token !== next.token || previous.apiBase !== next.apiBase;
    this.cfg = next;

    // 旧的限额/阻塞来自上一组凭证。最常见的情况是匿名 60 次/小时用完后才填 Token；
    // 如果继续沿用旧的 rateBlockedUntil，新 Token 要等到旧的 reset 时间才生效。
    if (authChanged) this.resetRateState();

    // 作者被移除/暂停后，不再补发它遗留的待推送事件
    this.pruneInactiveAuthorRepos();
    this.skipInactivePending();

    if (this.stopped) return;
    const turnedOn = !previous.enabled && next.enabled;
    const authorsChanged = !sameAuthors(previous.authors, next.authors);
    const reposChanged = !sameRepos(previous.repos, next.repos);
    const targetsChanged = !sameTargets(previous.targets, next.targets);
    const modeChanged = previous.mode !== next.mode;
    if (turnedOn) {
      this.scheduleNext(0);
    } else if (next.enabled && (authChanged || authorsChanged || reposChanged || targetsChanged || modeChanged)) {
      // 新 Token / 新作者 / 新仓库 / 新模式 / 新会话都尽快跑一轮：
      // 验证凭证、建立基线、补发积压。这里只提前一轮，不改写轮询间隔。
      this.scheduleNext(1_000);
    } else if (previous.intervalSec !== next.intervalSec) {
      this.scheduleNext(next.intervalSec * 1000);
    }
  }

  /** 凭证或 API 地址变了，上一次响应里的限额信息不再适用于新凭证 */
  private resetRateState(): void {
    this.rateLimit = null;
    this.rateRemaining = null;
    this.rateResetAt = null;
    this.rateBlockedUntil = 0;
    this.lastError = '';
  }

  /** 把「已停用/移除/切换模式后不再追踪」的待推送事件标记为 skipped */
  private skipInactivePending(): void {
    const activeAuthors = this.tracksAuthors()
      ? this.cfg.authors.filter((a) => a.enabled).map((a) => a.login.toLowerCase())
      : [];
    if (activeAuthors.length > 0) {
      const placeholders = activeAuthors.map(() => '?').join(',');
      this.store.db
        .prepare(
          `UPDATE github_events SET state='skipped', last_error=?
           WHERE state='pending' AND type NOT IN (?,?)
             AND lower(login) NOT IN (${placeholders})`,
        )
        .run('作者已暂停或移除', GITHUB_REPO_PUSH_TYPE, GITHUB_REPO_RELEASE_TYPE, ...activeAuthors);
    } else {
      this.store.db
        .prepare(
          `UPDATE github_events SET state='skipped', last_error=?
           WHERE state='pending' AND type NOT IN (?,?)`,
        )
        .run('作者已暂停或移除', GITHUB_REPO_PUSH_TYPE, GITHUB_REPO_RELEASE_TYPE);
    }

    const activeRepoSubs = this.activeRepoSubs();
    const activeRepos = activeRepoSubs.map((repo) => repo.repo.toLowerCase());
    if (activeRepos.length > 0) {
      const placeholders = activeRepos.map(() => '?').join(',');
      this.store.db
        .prepare(
          `UPDATE github_events SET state='skipped', last_error=?
           WHERE state='pending' AND type IN (?,?)
             AND lower(repo) NOT IN (${placeholders})`,
        )
        .run('仓库已暂停或移除', GITHUB_REPO_PUSH_TYPE, GITHUB_REPO_RELEASE_TYPE, ...activeRepos);
    } else {
      this.store.db
        .prepare(
          `UPDATE github_events SET state='skipped', last_error=?
           WHERE state='pending' AND type IN (?,?)`,
        )
        .run('仓库已暂停或移除', GITHUB_REPO_PUSH_TYPE, GITHUB_REPO_RELEASE_TYPE);
    }

    const noReleaseRepos = activeRepoSubs
      .filter((repo) => !repo.releases)
      .map((repo) => repo.repo.toLowerCase());
    if (noReleaseRepos.length > 0) {
      const placeholders = noReleaseRepos.map(() => '?').join(',');
      this.store.db
        .prepare(
          `UPDATE github_events SET state='skipped', last_error=?
           WHERE state='pending' AND type=? AND lower(repo) IN (${placeholders})`,
        )
        .run('仓库已取消 Release 订阅', GITHUB_REPO_RELEASE_TYPE, ...noReleaseRepos);
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

  private repoRow(key: string): RepoRow | undefined {
    return this.store.db.prepare('SELECT * FROM github_repos WHERE repo=?').get(key) as RepoRow | undefined;
  }

  private ensureRepoRow(key: string): RepoRow {
    const existing = this.repoRow(key);
    if (existing) return existing;
    this.store.db
      .prepare('INSERT OR IGNORE INTO github_repos(repo,baseline_at,last_polled_at) VALUES(?,?,?)')
      .run(key, 0, 0);
    return this.repoRow(key)!;
  }

  private markRepoError(repo: string, message: string): void {
    const key = repo.toLowerCase();
    this.ensureRepoRow(key);
    this.store.db
      .prepare('UPDATE github_repos SET last_error=?, last_polled_at=? WHERE repo=?')
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
