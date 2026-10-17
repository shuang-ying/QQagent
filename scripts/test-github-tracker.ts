/**
 * GitHub 动态追踪：离线回归
 *
 * 覆盖：
 *  - 配置归一化 / 校验 / 文件读写
 *  - 事件解析与排版、CQ 注入转义
 *  - 基线、去重、离线排队、失败重试、类型过滤、每轮上限
 *  - 304 / 限额用尽
 *  - 面板 API 与 Token 不泄漏
 *
 * 全部使用假 fetch、假 OneBot，不发真实网络请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import pino from 'pino';
import { MemoryStore } from '../src/memory/store.js';
import { AppConfigSchema } from '../src/core/types.js';
import { createServer } from '../src/server/api.js';
import { toCqCodes } from '../src/onebot/normalize.js';
import {
  GITHUB_EVENT_TYPES,
  GithubConfigSchema,
  defaultGithubConfig,
  loadGithubConfig,
  publicGithubConfig,
  saveGithubConfig,
  validateGithubConfig,
  type GithubConfig,
} from '../src/github/config.js';
import { formatGithubTime, parseGithubEvent, renderGithubEvent } from '../src/github/format.js';
import {
  GithubTracker,
  type GithubDeliverySender,
  type GithubFetch,
  type GithubHttpResponse,
} from '../src/github/tracker.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const log = pino({ level: 'silent' });

function event(
  id: string,
  type: string,
  login: string,
  repo: string,
  minutesAgo: number,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    actor: { login },
    repo: { name: repo },
    created_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    payload,
  };
}

function pushEvent(id: string, minutesAgo: number): Record<string, unknown> {
  return event(id, 'PushEvent', 'octocat', 'octocat/hello', minutesAgo, {
    size: 1,
    ref: 'refs/heads/main',
    head: 'abcdef1234567890',
    commits: [{ message: 'update ' + id }],
  });
}

function watchEvent(id: string, minutesAgo: number): Record<string, unknown> {
  return event(id, 'WatchEvent', 'octocat', 'octocat/hello', minutesAgo);
}

interface Step {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface FakeGithub {
  fetchImpl: GithubFetch;
  calls: string[];
}

function fakeGithub(plan: Record<string, Step[]>): FakeGithub {
  const calls: string[] = [];
  const index: Record<string, number> = {};
  const fetchImpl: GithubFetch = async (url) => {
    calls.push(url);
    const match = /\/users\/([^/]+)\/events/.exec(url);
    const login = match ? decodeURIComponent(match[1]!) : 'unknown';
    const steps = plan[login] ?? [{ body: [] }];
    const position = index[login] ?? 0;
    index[login] = position + 1;
    const step = steps[Math.min(position, steps.length - 1)]!;
    const headers = new Map(Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const status = step.status ?? 200;
    const response: GithubHttpResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: async () => (step.body === undefined ? [] : step.body),
      text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? '')),
    };
    return response;
  };
  return { fetchImpl, calls };
}

interface FixtureOptions {
  plan?: Record<string, Step[]>;
  config?: Partial<GithubConfig>;
  fetchImpl?: GithubFetch;
  ready?: boolean;
}

function fixture(opts: FixtureOptions = {}) {
  const store = new MemoryStore(':memory:');
  const config = GithubConfigSchema.parse({
    enabled: true,
    intervalSec: 60,
    maxEventsPerPoll: 5,
    maxEventAgeHours: 48,
    eventTypes: [...GITHUB_EVENT_TYPES],
    authors: [{ login: 'octocat', enabled: true }],
    targets: [
      { scope: 'group:10001', enabled: true },
      { scope: 'private:20002', enabled: true },
    ],
    ...(opts.config ?? {}),
  });
  const fake = opts.fetchImpl ? { fetchImpl: opts.fetchImpl, calls: [] as string[] } : fakeGithub(opts.plan ?? {});
  const sent: Array<{ scope: string; text: string; message: unknown }> = [];
  const failing = new Set<string>();
  const sender: GithubDeliverySender = {
    async sendToScope(scope, message) {
      if (failing.has(scope)) throw new Error('模拟发送失败');
      const text = Array.isArray(message)
        ? message.map((segment) => String(segment.data['text'] ?? '')).join('')
        : String(message);
      sent.push({ scope, text, message });
      return { message_id: sent.length };
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-github-'));
  let ready = opts.ready ?? true;
  const tracker = new GithubTracker({
    root: dir,
    config,
    sender,
    store,
    log,
    ready: () => ready,
    timezone: 'Asia/Shanghai',
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
  });
  tracker.start();
  return {
    tracker,
    store,
    sent,
    calls: fake.calls,
    dir,
    fail: (scope: string) => failing.add(scope),
    heal: (scope: string) => failing.delete(scope),
    setReady: (value: boolean) => {
      ready = value;
    },
    async dispose() {
      await tracker.stop();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('GitHub 配置：作者/会话去重、非法值拒绝、Token 不外泄', () => {
  const base = defaultGithubConfig();

  const ok = validateGithubConfig(
    { authors: ['octocat', 'OctoCat', 'torvalds'], targets: ['group:123456', 'group:123456', 'private:10001'] },
    base,
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.config.authors.length, 2); // GitHub 用户名大小写不敏感
    assert.equal(ok.config.targets.length, 2);
    assert.equal(ok.config.authors[0]!.login, 'octocat');
  }

  for (const bad of [
    { authors: ['bad login'] },
    { authors: ['-dash'] },
    { authors: [`${'a'.repeat(40)}`] },
    { targets: ['group:1'] },
    { targets: ['qq:12345'] },
    { intervalSec: 30 },
    { maxEventsPerPoll: 21 },
    { maxEventAgeHours: 0 },
    { eventTypes: ['PushEvent', 'NopeEvent'] },
    { token: 'has space' },
  ]) {
    assert.equal(validateGithubConfig(bad, base).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateGithubConfig({ intervalSec: 3600 }, base).ok, true);

  const publicCfg = publicGithubConfig(GithubConfigSchema.parse({ token: 'ghp_secret_value' }));
  assert.equal('token' in publicCfg, false);
  assert.equal(publicCfg.tokenSet, true);
});

test('GitHub 配置文件：保存后可读回，损坏时退回默认配置而不是崩溃', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-github-cfg-'));
  try {
    const config = GithubConfigSchema.parse({
      enabled: true,
      authors: [{ login: 'octocat', enabled: true }],
      targets: [{ scope: 'group:10001', enabled: true }],
    });
    saveGithubConfig(dir, config);
    const loaded = loadGithubConfig(dir);
    assert.equal(loaded.warning, undefined);
    assert.equal(loaded.config.enabled, true);
    assert.equal(loaded.config.authors[0]!.login, 'octocat');
    assert.equal(loaded.config.targets[0]!.scope, 'group:10001');

    fs.writeFileSync(path.join(dir, 'config', 'github.yaml'), '{ bad');
    const broken = loadGithubConfig(dir);
    assert.equal(broken.config.enabled, false);
    assert.ok(broken.warning);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitHub 事件排版：推送/发布/PR，且不可信正文经 CQ 转义', () => {
  const push = parseGithubEvent(
    event('1', 'PushEvent', 'octocat', 'octocat/hello', 5, {
      size: 2,
      ref: 'refs/heads/main',
      head: 'abcdef1234567890',
      commits: [{ message: 'fix: 修复 [CQ:at,qq=all] 注入' }, { message: 'docs: 更新说明' }],
    }),
  );
  assert.ok(push);
  const rendered = renderGithubEvent(push, 'Asia/Shanghai');
  assert.match(rendered.text, /推送 2 个提交/);
  assert.match(rendered.text, /🔗 https:\/\/github\.com\/octocat\/hello\/commit\/abcdef1234567890/);
  // 发送层把 text 段转义，恶意提交信息不会变成真正的 @全体成员
  const wire = toCqCodes([{ type: 'text', data: { text: rendered.text } }]);
  assert.ok(wire.includes('&#91;CQ:at'));
  assert.ok(wire.includes('&#93;'));
  assert.ok(!/\[CQ:at/.test(wire));

  const release = parseGithubEvent(
    event('2', 'ReleaseEvent', 'octocat', 'octocat/hello', 3, {
      release: {
        tag_name: 'v1.2.0',
        name: '1.2.0',
        body: '修复若干问题',
        prerelease: false,
        html_url: 'https://github.com/octocat/hello/releases/tag/v1.2.0',
      },
    }),
  );
  const releaseText = renderGithubEvent(release!, 'Asia/Shanghai').text;
  assert.match(releaseText, /🚀 发布 v1\.2\.0/);
  assert.match(releaseText, /https:\/\/github\.com\/octocat\/hello\/releases\/tag\/v1\.2\.0/);

  const pr = parseGithubEvent(
    event('3', 'PullRequestEvent', 'octocat', 'octocat/hello', 2, {
      action: 'closed',
      number: 42,
      pull_request: { title: 'feat: 新功能', merged: true, html_url: 'https://github.com/octocat/hello/pull/42' },
    }),
  );
  assert.match(renderGithubEvent(pr!, 'Asia/Shanghai').text, /✅ 合并 PR #42/);

  assert.equal(parseGithubEvent({ id: '', type: 'PushEvent' }), null);
  assert.equal(formatGithubTime(NOW, 'Asia/Shanghai'), '2026-10-17 20:00');
});

test('首次轮询只建立基线，历史动态不推送且不会重复入库', async () => {
  const f = fixture({ plan: { octocat: [{ body: [pushEvent('base', 30)] }] } });
  try {
    const first = await f.tracker.pollNow();
    assert.equal(first.ok, true);
    assert.equal(first.fetched, 0);
    assert.equal(f.sent.length, 0);

    const snapshot = f.tracker.snapshot();
    assert.equal(snapshot.authors[0]!.baselineAt, NOW);
    assert.equal(snapshot.runtime.pendingCount, 0);

    const second = await f.tracker.pollNow();
    assert.equal(second.fetched, 0);
    assert.equal(f.sent.length, 0);
    const rows = f.store.db.prepare('SELECT COUNT(*) AS n FROM github_events').get() as { n: number };
    assert.equal(rows.n, 1);
  } finally {
    await f.dispose();
  }
});

test('新动态推送到本页配置的会话；离线排队、上线补发并写入会话历史', async () => {
  const f = fixture({
    plan: {
      octocat: [
        { body: [pushEvent('base', 30)] },
        { body: [pushEvent('base', 30), watchEvent('new', 1)] },
      ],
    },
  });
  try {
    await f.tracker.pollNow(); // 基线
    f.setReady(false);
    const offline = await f.tracker.pollNow();
    assert.equal(offline.fetched, 1);
    assert.equal(f.sent.length, 0);
    assert.equal(f.tracker.snapshot().runtime.pendingCount, 1);

    f.setReady(true);
    const online = await f.tracker.pollNow();
    assert.equal(online.delivered, 1);
    assert.equal(f.sent.length, 2); // 两个推送会话各一条，与群/用户白名单无关
    assert.deepEqual(f.sent.map((item) => item.scope).sort(), ['group:10001', 'private:20002']);
    // 必须是消息段数组，不能把不可信正文当裸字符串发
    assert.ok(Array.isArray(f.sent[0]!.message));

    const history = f.store.getRecentMessages('group:10001', 10);
    assert.ok(history.some((message) => message.content.includes('Star')));
    const state = f.store.db.prepare("SELECT state FROM github_events WHERE event_id='new'").get() as { state: string };
    assert.equal(state.state, 'sent');
  } finally {
    await f.dispose();
  }
});

test('部分会话失败时只重试失败的那个，不重复打扰已送达的会话', async () => {
  const f = fixture({
    plan: {
      octocat: [
        { body: [pushEvent('base', 30)] },
        { body: [pushEvent('base', 30), watchEvent('new', 1)] },
      ],
    },
  });
  try {
    await f.tracker.pollNow(); // 基线
    f.fail('private:20002');
    const first = await f.tracker.pollNow();
    assert.equal(first.fetched, 1);
    assert.equal(first.delivered, 0); // 群成功、私聊失败 → 事件仍 pending
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.scope, 'group:10001');
    const pending = f.store.db.prepare("SELECT state,attempts FROM github_events WHERE event_id='new'").get() as {
      state: string;
      attempts: number;
    };
    assert.equal(pending.state, 'pending');
    assert.equal(pending.attempts, 1);

    f.heal('private:20002');
    const second = await f.tracker.pollNow();
    assert.equal(second.delivered, 1);
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent.filter((item) => item.scope === 'group:10001').length, 1); // 群没有收到第二遍
    const done = f.store.db.prepare("SELECT state FROM github_events WHERE event_id='new'").get() as { state: string };
    assert.equal(done.state, 'sent');
  } finally {
    await f.dispose();
  }
});

test('304 不重复推送；限额用尽时停止请求但继续投递待发事件', async () => {
  const headers = { 'etag': '"v1"' };
  const f = fixture({
    plan: {
      octocat: [
        { body: [pushEvent('base', 30)], headers },
        { status: 304, headers },
        {
          body: [pushEvent('base', 30), pushEvent('new', 1)],
          headers: {
            'etag': '"v2"',
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 3600),
          },
        },
      ],
    },
  });
  try {
    await f.tracker.pollNow(); // 基线
    const notModified = await f.tracker.pollNow();
    assert.equal(notModified.ok, true);
    assert.equal(notModified.fetched, 0);
    assert.equal(f.calls.length, 2);
    // If-None-Match 应该带上上一轮的 ETag
    assert.equal(f.sent.length, 0);

    // 第三轮：有新事件且限额归零
    const limited = await f.tracker.pollNow();
    assert.equal(limited.fetched, 1);
    assert.equal(limited.delivered, 1);

    const blocked = await f.tracker.pollNow();
    assert.equal(f.calls.length, 3); // 限额用尽后不再请求 GitHub
    assert.ok(blocked.errors.some((message) => message.includes('限额')));
    assert.equal(f.sent.length, 2); // 没有重复推送
  } finally {
    await f.dispose();
  }
});

test('按事件类型过滤，并按每个作者每轮上限分批推送', async () => {
  const f = fixture({
    config: { maxEventsPerPoll: 1, eventTypes: ['PushEvent'] },
    plan: {
      octocat: [
        { body: [pushEvent('base', 30)] },
        { body: [pushEvent('p1', 3), pushEvent('p2', 2), pushEvent('p3', 1), watchEvent('w1', 4)] },
      ],
    },
  });
  try {
    await f.tracker.pollNow(); // 基线
    const first = await f.tracker.pollNow();
    assert.equal(first.fetched, 3); // WatchEvent 被过滤
    assert.equal(first.delivered, 1); // 每轮每个作者只推 1 条
    assert.equal(f.sent.length, 2); // 两个会话

    const watch = f.store.db.prepare("SELECT state FROM github_events WHERE event_id='w1'").get() as
      | { state: string }
      | undefined;
    assert.equal(watch?.state, 'skipped');

    const second = await f.tracker.pollNow();
    assert.equal(second.delivered, 1);
    const third = await f.tracker.pollNow();
    assert.equal(third.delivered, 1);
    const fourth = await f.tracker.pollNow();
    assert.equal(fourth.delivered, 0);
    assert.equal(f.tracker.snapshot().runtime.pendingCount, 0);
    assert.equal(f.sent.length, 6); // 3 条事件 x 2 个会话，未重复
  } finally {
    await f.dispose();
  }
});

test('面板取消事件类型后，已经排队的同类型动态不再补发', async () => {
  const f = fixture({
    plan: {
      octocat: [
        { body: [pushEvent('base', 30)] },
        { body: [pushEvent('base', 30), watchEvent('new', 1)] },
      ],
    },
  });
  try {
    await f.tracker.pollNow(); // 基线
    f.setReady(false);
    await f.tracker.pollNow(); // WatchEvent 进入待推送队列，但 OneBot 离线
    assert.equal(f.tracker.snapshot().runtime.pendingCount, 1);

    f.tracker.saveConfig({ eventTypes: ['PushEvent'] });
    f.setReady(true);
    const after = await f.tracker.pollNow();
    assert.equal(after.delivered, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.tracker.snapshot().runtime.pendingCount, 0);
    const row = f.store.db.prepare("SELECT state,last_error FROM github_events WHERE event_id='new'").get() as {
      state: string;
      last_error: string;
    };
    assert.equal(row.state, 'skipped');
    assert.match(row.last_error, /取消/);
  } finally {
    await f.dispose();
  }
});

test('保存新增作者或会话后提前安排下一轮，不用等满轮询间隔', async () => {
  const f = fixture({ plan: { octocat: [{ body: [] }], torvalds: [{ body: [] }] } });
  try {
    assert.ok(f.tracker.snapshot().runtime.nextPollAt >= NOW + 9_000);
    f.tracker.saveConfig({ authors: ['octocat', 'torvalds'] });
    const next = f.tracker.snapshot().runtime.nextPollAt;
    assert.ok(next > NOW);
    assert.ok(next <= NOW + 2_000, `nextPollAt=${next}`);
  } finally {
    await f.dispose();
  }
});

test('OneBot 恢复就绪后，立即补发离线期间积压的动态', async () => {
  const f = fixture({
    ready: false,
    plan: {
      octocat: [
        { body: [pushEvent('base', 30)] },
        { body: [pushEvent('base', 30), watchEvent('new', 1)] },
      ],
    },
  });
  try {
    await f.tracker.pollNow(); // 基线
    await f.tracker.pollNow(); // 新事件排队，但 OneBot 未就绪
    assert.equal(f.tracker.snapshot().runtime.pendingCount, 1);
    assert.equal(f.sent.length, 0);

    f.setReady(true);
    await f.tracker.notifyReady();
    assert.equal(f.tracker.snapshot().runtime.pendingCount, 0);
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.sent.map((item) => item.scope).sort(), ['group:10001', 'private:20002']);
  } finally {
    await f.dispose();
  }
});

test('GitHub 面板 API：状态脱敏、保存校验、立即检查与测试消息', async () => {
  const f = fixture({
    config: { token: 'ghp_secret_value' },
    plan: { octocat: [{ body: [pushEvent('base', 30)] }] },
  });
  try {
    const deps = {
      cfg: AppConfigSchema.parse({}),
      store: f.store,
      providers: {},
      personas: {},
      log,
      runtime: () => ({ napcatConnected: true, selfId: 0, nickname: '', uptimeMs: 1, startedAt: 1 }),
      github: f.tracker,
    } as unknown as Parameters<typeof createServer>[0];
    const { app } = createServer(deps);
    const json = (response: Response) => response.json() as Promise<Record<string, unknown>>;

    const stateResponse = await app.request('/api/github/state');
    assert.equal(stateResponse.status, 200);
    const stateText = JSON.stringify(await json(stateResponse));
    assert.ok(!stateText.includes('ghp_secret_value'));
    assert.ok(stateText.includes('"tokenSet":true'));

    const bad = await app.request('/api/github/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalSec: 5 }),
    });
    assert.equal(bad.status, 400);

    const good = await app.request('/api/github/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalSec: 120, authors: ['octocat', 'torvalds'] }),
    });
    assert.equal(good.status, 200);
    const saved = (await json(good)) as { config: { intervalSec: number; authors: unknown[] } };
    assert.equal(saved.config.intervalSec, 120);
    assert.equal(saved.config.authors.length, 2);
    assert.ok(fs.existsSync(path.join(f.dir, 'config', 'github.yaml')));

    const poll = await app.request('/api/github/poll', { method: 'POST', body: '{}' });
    assert.equal(poll.status, 200);
    const pollResult = (await json(poll)) as { fetched: number; delivered: number };
    assert.equal(pollResult.fetched, 0);

    const testSend = await app.request('/api/github/test', { method: 'POST', body: '{}' });
    assert.equal(testSend.status, 200);
    const testResult = (await json(testSend)) as { ok: boolean; results: Array<{ ok: boolean }> };
    assert.equal(testResult.ok, true);
    assert.equal(testResult.results.length, 2);
  } finally {
    await f.dispose();
  }
});

test('面板含 GitHub 追踪页，内嵌脚本可编译', () => {
  const html = fs.readFileSync('src/web/panel.html', 'utf8');
  assert.match(html, /data-page="github"/);
  assert.match(html, /id="page-github"/);
  assert.match(html, /id="gh_settings"/);
  assert.match(html, /\/api\/github\/state/);
  assert.match(html, /\/api\/github\/config/);
  // 「下次检查」必须是独立的节点，由 1 秒定时器本地刷新，而不是只在 10 秒拉取时重算
  assert.match(html, /id="gh_nextPoll"/);
  assert.match(html, /function updateGithubCountdown/);
  assert.match(html, /setInterval\(updateGithubCountdown, 1000\)/);
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const script of scripts) new vm.Script(script[1]!);
});
