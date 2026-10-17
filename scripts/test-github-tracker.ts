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
  type GithubSummarizer,
  type GithubSummaryInput,
} from '../src/github/tracker.js';
import { createGithubSummarizer } from '../src/github/summarize.js';

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
    // 每个测试事件用不同 head，模拟真实的不同 push；同一 head 会被跨源去重
    head: id.padEnd(40, '0').slice(0, 40),
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

function stepResponse(step: Step): GithubHttpResponse {
  const headers = new Map(Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const status = step.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => (step.body === undefined ? [] : step.body),
    text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? '')),
  };
}

function fakeGithub(
  plan: Record<string, Step[]>,
  authorRepos: Record<string, Step[]> = {},
): FakeGithub {
  const calls: string[] = [];
  const index: Record<string, number> = {};
  const repoIndex: Record<string, number> = {};
  const fetchImpl: GithubFetch = async (url) => {
    calls.push(url);
    const repoMatch = /\/users\/([^/]+)\/repos/.exec(url);
    if (repoMatch) {
      const login = decodeURIComponent(repoMatch[1]!);
      const steps = authorRepos[login] ?? [{ body: [] }];
      const position = repoIndex[login] ?? 0;
      repoIndex[login] = position + 1;
      return stepResponse(steps[Math.min(position, steps.length - 1)]!);
    }
    const match = /\/users\/([^/]+)\/events/.exec(url);
    const login = match ? decodeURIComponent(match[1]!) : 'unknown';
    const steps = plan[login] ?? [{ body: [] }];
    const position = index[login] ?? 0;
    index[login] = position + 1;
    return stepResponse(steps[Math.min(position, steps.length - 1)]!);
  };
  return { fetchImpl, calls };
}

interface RepoPlan {
  commits: Step[];
  releases?: Step[];
  compare?: Step[];
}

/** 仓库订阅用假 fetch：按 URL 路由 commits / releases / compare */
function fakeRepoGithub(plan: RepoPlan): FakeGithub {
  const calls: string[] = [];
  const indexes = { commits: 0, releases: 0, compare: 0 };
  const fetchImpl: GithubFetch = async (url) => {
    calls.push(url);
    if (/\/compare\//.test(url)) {
      const steps = plan.compare ?? [{ body: { commits: [], total_commits: 0 } }];
      return stepResponse(steps[Math.min(indexes.compare++, steps.length - 1)]!);
    }
    if (/\/releases(\?|$)/.test(url)) {
      const steps = plan.releases ?? [{ body: [] }];
      return stepResponse(steps[Math.min(indexes.releases++, steps.length - 1)]!);
    }
    const steps = plan.commits;
    return stepResponse(steps[Math.min(indexes.commits++, steps.length - 1)]!);
  };
  return { fetchImpl, calls };
}

/** 作者事件/公开仓库发现 + 仓库 commits/releases 的组合假 fetch */
function fakeAuthorRepoGithub(
  eventsPlan: Record<string, Step[]>,
  authorRepos: Record<string, Step[]>,
  repoPlan: RepoPlan,
): FakeGithub {
  const events = fakeGithub(eventsPlan, authorRepos);
  const repos = fakeRepoGithub(repoPlan);
  const calls: string[] = [];
  const fetchImpl: GithubFetch = (url, init) => {
    calls.push(url);
    return url.includes('/repos/') ? repos.fetchImpl(url, init) : events.fetchImpl(url, init);
  };
  return { fetchImpl, calls };
}

function repoCommit(
  sha: string,
  minutesAgo: number,
  opts: { login?: string; message?: string } = {},
): Record<string, unknown> {
  return {
    sha,
    commit: {
      message: opts.message ?? `commit ${sha}`,
      author: { name: opts.login ?? 'Octo Cat', date: new Date(NOW - minutesAgo * 60_000).toISOString() },
    },
    author: { login: opts.login ?? 'octocat' },
    html_url: `https://github.com/owner/repo/commit/${sha}`,
  };
}

function repoRelease(
  id: number,
  tag: string,
  minutesAgo: number,
  opts: { body?: string; prerelease?: boolean } = {},
): Record<string, unknown> {
  return {
    id,
    tag_name: tag,
    name: tag,
    body: opts.body ?? '',
    prerelease: opts.prerelease ?? false,
    draft: false,
    published_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    html_url: `https://github.com/owner/repo/releases/tag/${tag}`,
  };
}

interface FixtureOptions {
  plan?: Record<string, Step[]>;
  authorRepos?: Record<string, Step[]>;
  config?: Partial<GithubConfig>;
  fetchImpl?: GithubFetch;
  ready?: boolean;
  summarize?: GithubSummarizer;
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
  const fake = opts.fetchImpl
    ? { fetchImpl: opts.fetchImpl, calls: [] as string[] }
    : fakeGithub(opts.plan ?? {}, opts.authorRepos);
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
    summarize: opts.summarize,
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

function repoFixture(opts: {
  plan: RepoPlan;
  config?: Partial<GithubConfig>;
  summarize?: GithubSummarizer;
}) {
  const fake = fakeRepoGithub(opts.plan);
  const f = fixture({
    fetchImpl: fake.fetchImpl,
    config: {
      mode: 'repos',
      authors: [],
      repos: [{ repo: 'owner/repo', branch: 'main', releases: true, enabled: true }],
      ...(opts.config ?? {}),
    },
    summarize: opts.summarize,
  });
  return { ...f, calls: fake.calls };
}

test('GitHub 配置：作者/会话去重、非法值拒绝、Token 不外泄', () => {
  const base = defaultGithubConfig();
  assert.equal(base.aiSummary, true);
  assert.equal(base.repoDiscoverySec, 10800);

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
    { aiSummary: 'yes' },
    { repoDiscoverySec: 299 },
  ]) {
    assert.equal(validateGithubConfig(bad, base).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateGithubConfig({ intervalSec: 3600 }, base).ok, true);
  assert.equal(validateGithubConfig({ repoDiscoverySec: 300 }, base).ok, true);
  assert.equal(validateGithubConfig({ repoDiscoverySec: 604800 }, base).ok, true);
  const noSummary = validateGithubConfig({ aiSummary: false }, base);
  assert.equal(noSummary.ok, true);
  if (noSummary.ok) assert.equal(noSummary.config.aiSummary, false);

  const publicCfg = publicGithubConfig(GithubConfigSchema.parse({ token: 'ghp_secret_value' }));
  assert.equal('token' in publicCfg, false);
  assert.equal(publicCfg.tokenSet, true);
});

test('GitHub 仓库订阅配置：模式、owner/repo、分支与去重', () => {
  const base = defaultGithubConfig();
  assert.equal(base.mode, 'authors');

  const ok = validateGithubConfig(
    {
      mode: 'repos',
      repos: [
        { repo: 'OctoCat/Hello-World', branch: 'main', releases: false },
        'octocat/hello-world',
      ],
    },
    base,
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.config.mode, 'repos');
    assert.equal(ok.config.repos.length, 1); // 大小写不敏感去重
    assert.equal(ok.config.repos[0]!.repo, 'OctoCat/Hello-World');
    assert.equal(ok.config.repos[0]!.branch, 'main');
    assert.equal(ok.config.repos[0]!.releases, false);
  }

  for (const bad of [
    { mode: 'nope' },
    { repos: ['no-slash'] },
    { repos: ['a/b/c'] },
    { repos: [{ repo: 'a/b', branch: 'bad branch' }] },
    { repos: [{ repo: '-bad/repo' }] },
  ]) {
    assert.equal(validateGithubConfig(bad, base).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateGithubConfig({ repos: ['owner/repo'] }, base).ok, true);
});

test('仓库订阅：首次只建基线，HEAD 变化和 Release 推送到本页会话', async () => {
  const f = repoFixture({
    plan: {
      commits: [
        { body: [repoCommit('base', 30)] },
        {
          body: [
            repoCommit('new', 1, { login: 'alice', message: 'feat: 新功能\n\n详细说明' }),
            repoCommit('base', 30),
          ],
        },
        {
          body: [
            repoCommit('new', 1, { login: 'alice', message: 'feat: 新功能\n\n详细说明' }),
            repoCommit('base', 30),
          ],
        },
      ],
      releases: [
        { body: [repoRelease(1, 'v1.0.0', 60)] },
        { body: [repoRelease(2, 'v1.1.0', 1, { body: '修复若干问题' }), repoRelease(1, 'v1.0.0', 60)] },
        { body: [repoRelease(2, 'v1.1.0', 1, { body: '修复若干问题' }), repoRelease(1, 'v1.0.0', 60)] },
      ],
    },
  });
  try {
    const baseline = await f.tracker.pollNow();
    assert.equal(baseline.ok, true);
    assert.equal(baseline.fetched, 0);
    assert.equal(f.sent.length, 0);
    const before = f.tracker.snapshot();
    assert.equal(before.repos[0]!.baselineAt, NOW);
    assert.equal(before.repos[0]!.headSha, 'base');
    assert.equal(before.repos[0]!.releaseTag, 'v1.0.0');

    const first = await f.tracker.pollNow();
    assert.equal(first.ok, true);
    assert.equal(first.fetched, 2); // 一次 push + 一次 release
    assert.equal(first.delivered, 2); // 两个事件
    assert.equal(f.sent.length, 4); // 每个事件 x 两个会话
    assert.deepEqual(f.sent.map((item) => item.scope).sort(), [
      'group:10001',
      'group:10001',
      'private:20002',
      'private:20002',
    ]);
    const pushText = f.sent.find((item) => item.text.includes('新提交'))!.text;
    assert.match(pushText, /有 1 个新提交/);
    assert.match(pushText, /@alice/);
    assert.match(pushText, /feat: 新功能/);
    const releaseText = f.sent.find((item) => item.text.includes('发布'))!.text;
    assert.match(releaseText, /🚀 发布 v1\.1\.0/);
    assert.match(releaseText, /修复若干问题/);
    assert.ok(f.calls.some((url) => url.includes('/repos/owner/repo/commits')));
    assert.ok(f.calls.some((url) => url.includes('/repos/owner/repo/releases')));

    const after = f.tracker.snapshot();
    assert.equal(after.repos[0]!.headSha, 'new');
    assert.equal(after.repos[0]!.releaseTag, 'v1.1.0');
    assert.equal(after.runtime.pendingCount, 0);

    const again = await f.tracker.pollNow();
    assert.equal(again.fetched, 0);
    assert.equal(f.sent.length, 4); // 不重复推送
    const state = f.store.db
      .prepare("SELECT state FROM github_events WHERE event_id LIKE 'repo-push:%'")
      .get() as { state: string };
    assert.equal(state.state, 'sent');
  } finally {
    await f.dispose();
  }
});

test('仓库订阅：旧 HEAD 不在最近提交里时用 compare 拿到完整提交数', async () => {
  const f = repoFixture({
    plan: {
      commits: [
        { body: [repoCommit('base', 30)] },
        { body: [repoCommit('new', 1), repoCommit('mid', 2)] },
      ],
      compare: [
        {
          body: {
            status: 'diverged',
            total_commits: 3,
            commits: [repoCommit('c1', 3), repoCommit('c2', 2), repoCommit('c3', 1)],
          },
        },
      ],
      releases: [{ body: [] }, { body: [] }],
    },
  });
  try {
    await f.tracker.pollNow(); // 基线
    const result = await f.tracker.pollNow();
    assert.equal(result.fetched, 1);
    assert.equal(f.sent.length, 2);
    const text = f.sent[0]!.text;
    assert.match(text, /有 3 个新提交/);
    assert.match(text, /@octocat/);
    assert.ok(f.calls.some((url) => url.includes('/compare/base...new')));
  } finally {
    await f.dispose();
  }
});

test('仓库订阅切回作者模式后不再轮询仓库，积压事件标记 skipped', async () => {
  const f = repoFixture({
    plan: {
      commits: [
        { body: [repoCommit('base', 30)] },
        { body: [repoCommit('new', 1), repoCommit('base', 30)] },
      ],
      releases: [{ body: [] }, { body: [] }],
    },
  });
  try {
    await f.tracker.pollNow(); // 基线
    f.setReady(false);
    const pending = await f.tracker.pollNow();
    assert.equal(pending.fetched, 1);
    assert.equal(f.tracker.snapshot().runtime.pendingCount, 1);

    f.tracker.saveConfig({ mode: 'authors' });
    assert.equal(f.tracker.snapshot().runtime.pendingCount, 0);
    const row = f.store.db
      .prepare("SELECT state FROM github_events WHERE event_id LIKE 'repo-push:%'")
      .get() as { state: string };
    assert.equal(row.state, 'skipped');

    const calls = f.calls.length;
    await f.tracker.pollNow();
    assert.equal(f.calls.length, calls); // 作者模式、作者列表为空：不再发仓库请求
  } finally {
    await f.dispose();
  }
});

test('修改订阅分支时重建 HEAD 基线，不把新分支历史当新提交', async () => {
  const f = repoFixture({
    plan: {
      commits: [
        { body: [repoCommit('main-head', 30)] },
        { body: [repoCommit('dev-head', 1)] },
      ],
      releases: [{ body: [] }, { body: [] }],
    },
  });
  try {
    await f.tracker.pollNow(); // main 基线
    f.tracker.saveConfig({ repos: [{ repo: 'owner/repo', branch: 'dev', releases: true, enabled: true }] });
    const switched = await f.tracker.pollNow();
    assert.equal(switched.fetched, 0);
    assert.equal(f.sent.length, 0);
    const snap = f.tracker.snapshot();
    assert.equal(snap.repos[0]!.branch, 'dev');
    assert.equal(snap.repos[0]!.headSha, 'dev-head');
    assert.equal(snap.repos[0]!.baselineAt, NOW);
  } finally {
    await f.dispose();
  }
});

test('仓库订阅 AI 总结：开关、追加在原文下方、失败回退', async () => {
  const makePlan = () => ({
    commits: [
      { body: [repoCommit('base', 30)] },
      {
        body: [
          repoCommit('new', 1, { login: 'alice', message: 'feat: 新增登录\n\n详细说明' }),
          repoCommit('base', 30),
        ],
      },
    ],
    releases: [
      { body: [repoRelease(1, 'v1.0.0', 60)] },
      { body: [repoRelease(2, 'v1.1.0', 1, { body: '新增登录与修复若干问题' }), repoRelease(1, 'v1.0.0', 60)] },
    ],
  });

  const inputs: GithubSummaryInput[] = [];
  const f = repoFixture({
    plan: makePlan(),
    summarize: async (input) => {
      inputs.push(input);
      return '新增登录能力\n修复若干问题';
    },
  });
  try {
    await f.tracker.pollNow(); // 基线
    await f.tracker.pollNow();
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs.map((item) => item.kind), ['push', 'release']);
    assert.equal(inputs[0]!.repo, 'owner/repo');
    assert.equal(inputs[0]!.total, 1);
    assert.equal(inputs[0]!.commits?.[0]?.author, 'alice');
    assert.equal(inputs[1]!.release?.tag, 'v1.1.0');
    assert.equal(f.sent.length, 4);
    const pushText = f.sent.find((item) => item.text.includes('有 1 个新提交'))!.text;
    const releaseText = f.sent.find((item) => item.text.includes('发布 v1.1.0'))!.text;
    for (const text of [pushText, releaseText]) {
      assert.match(text, /🤖 AI 总结/);
      assert.match(text, /· 新增登录能力/);
      assert.ok(text.indexOf('🤖 AI 总结') > text.indexOf('🕐'));
    }
  } finally {
    await f.dispose();
  }

  let called = 0;
  const off = repoFixture({
    plan: makePlan(),
    config: { aiSummary: false },
    summarize: async () => {
      called++;
      return '不应出现';
    },
  });
  try {
    await off.tracker.pollNow();
    await off.tracker.pollNow();
    assert.equal(called, 0);
    assert.equal(off.sent.length, 4);
    assert.ok(off.sent.every((item) => !item.text.includes('AI 总结')));
  } finally {
    await off.dispose();
  }

  const fail = repoFixture({
    plan: makePlan(),
    summarize: async () => {
      throw new Error('模拟摘要失败');
    },
  });
  try {
    await fail.tracker.pollNow();
    await fail.tracker.pollNow();
    assert.equal(fail.sent.length, 4);
    assert.ok(fail.sent.every((item) => !item.text.includes('AI 总结')));
    assert.ok(fail.sent.some((item) => item.text.includes('有 1 个新提交')));
  } finally {
    await fail.dispose();
  }
});

test('AI 总结器：走 summary 角色并保留失败回退', async () => {
  const calls: Array<{
    messages: Array<{ role: string; content: string }>;
    provider: string;
    model?: string;
    purpose?: string;
  }> = [];
  const fake = {
    resolveRole: () => ({ provider: 'p', model: 'm' }),
    chat: async (
      messages: Array<{ role: string; content: string }>,
      provider: string,
      model: string | undefined,
      opts: { purpose?: string },
    ) => {
      calls.push({ messages, provider, model, purpose: opts.purpose });
      return { content: '摘要结果' };
    },
  } as unknown as Parameters<typeof createGithubSummarizer>[0];
  const text = await createGithubSummarizer(fake, log)({
    kind: 'push',
    repo: 'owner/repo',
    branch: 'main',
    commits: [{ sha: 'abc1234', author: 'alice', message: 'feat: 新功能' }],
  });
  assert.equal(text, '摘要结果');
  assert.equal(calls[0]!.provider, 'p');
  assert.equal(calls[0]!.purpose, 'summary');
  assert.match(calls[0]!.messages[1]!.content, /owner\/repo/);
  assert.match(calls[0]!.messages[1]!.content, /feat: 新功能/);

  const failing = {
    resolveRole: () => ({ provider: 'p', model: 'm' }),
    chat: async () => {
      throw new Error('模拟模型失败');
    },
  } as unknown as Parameters<typeof createGithubSummarizer>[0];
  assert.equal(
    await createGithubSummarizer(failing, log)({
      kind: 'release',
      repo: 'owner/repo',
      branch: 'main',
      release: { tag: 'v1', name: 'v1', body: 'notes', prerelease: false },
    }),
    '',
  );
});

test('追踪作者自动发现并订阅其公开仓库，取消作者一起取消', async () => {
  const fake = fakeAuthorRepoGithub(
    { octocat: [{ body: [] }, { body: [] }] },
    {
      octocat: [
        {
          body: [
            { full_name: 'octocat/hello', private: false, size: 1 },
            { full_name: 'octocat/private-repo', private: true, size: 1 },
            { full_name: 'octocat/empty-repo', private: false, size: 0 },
          ],
        },
      ],
    },
    {
      commits: [
        { body: [repoCommit('base', 30)] },
        { body: [repoCommit('new-head', 1), repoCommit('base', 30)] },
      ],
      releases: [{ body: [] }, { body: [] }],
    },
  );
  const f = fixture({
    fetchImpl: fake.fetchImpl,
    config: { mode: 'authors', repos: [] },
    summarize: async () => '新增功能',
  });
  try {
    await f.tracker.pollNow(); // 发现 + 作者/仓库基线
    let snap = f.tracker.snapshot();
    assert.equal(snap.authors[0]!.repoCount, 1);
    assert.equal(snap.authorRepos.length, 1);
    assert.equal(snap.authorRepos[0]!.repo, 'octocat/hello');
    assert.equal(snap.authorRepos[0]!.baselineAt, NOW);
    assert.equal(f.sent.length, 0);

    await f.tracker.pollNow();
    assert.equal(f.sent.length, 2);
    const text = f.sent[0]!.text;
    assert.match(text, /📦 GitHub 仓库 · octocat\/hello/);
    assert.match(text, /有 1 个新提交/);
    assert.match(text, /🤖 AI 总结/);

    f.tracker.saveConfig({ authors: [] });
    snap = f.tracker.snapshot();
    assert.equal(snap.authorRepos.length, 0);
    assert.equal(
      (f.store.db.prepare('SELECT COUNT(*) AS c FROM github_author_repos').get() as { c: number }).c,
      0,
    );
    assert.equal(
      (f.store.db
        .prepare("SELECT COUNT(*) AS c FROM github_repos WHERE repo='octocat/hello'")
        .get() as { c: number }).c,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test('作者公开事件与仓库订阅同一 push 只发一条，仓库消息优先', async () => {
  const newSha = 'cafebabecafebabecafebabecafebabecafebabe';
  const fake = fakeAuthorRepoGithub(
    {
      octocat: [
        { body: [] },
        {
          body: [
            event('push-dup', 'PushEvent', 'octocat', 'octocat/hello', 1, {
              size: 1,
              ref: 'refs/heads/main',
              head: newSha,
              commits: [{ message: 'feat: 新增登录' }],
            }),
          ],
        },
      ],
    },
    {
      octocat: [{ body: [{ full_name: 'octocat/hello', private: false, size: 1 }] }],
    },
    {
      commits: [
        { body: [repoCommit('base', 30)] },
        { body: [repoCommit(newSha, 1), repoCommit('base', 30)] },
      ],
      releases: [{ body: [] }, { body: [] }],
    },
  );
  const f = fixture({
    fetchImpl: fake.fetchImpl,
    config: { mode: 'authors', repos: [] },
    summarize: async () => '新增登录能力',
  });
  try {
    await f.tracker.pollNow(); // 基线
    await f.tracker.pollNow();

    assert.equal(f.sent.length, 2); // 同一事件只发到两个会话
    const text = f.sent[0]!.text;
    assert.match(text, /📦 GitHub 仓库 · octocat\/hello/);
    assert.match(text, /🤖 AI 总结/);
    assert.match(text, /· 新增登录能力/);

    const rows = f.store.db
      .prepare('SELECT event_id,type,repo,dedupe_key,state FROM github_events')
      .all() as unknown as Array<{ event_id: string; type: string; repo: string; dedupe_key: string; state: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.type, 'RepoPush');
    assert.equal(rows[0]!.dedupe_key, `push:octocat/hello:${newSha}`);
    assert.notEqual(rows[0]!.event_id, 'repo-push:octocat/hello:' + newSha);
  } finally {
    await f.dispose();
  }
});

test('手动订阅与作者自动仓库重叠时共用轮询，取消作者保留手动订阅', async () => {
  const fake = fakeAuthorRepoGithub(
    { octocat: [{ body: [] }, { body: [] }] },
    { octocat: [{ body: [{ full_name: 'octocat/hello', private: false, size: 1 }] }] },
    {
      commits: [
        { body: [repoCommit('base', 30)] },
        { body: [repoCommit('new-head', 1), repoCommit('base', 30)] },
      ],
      releases: [{ body: [] }, { body: [] }],
    },
  );
  const f = fixture({
    fetchImpl: fake.fetchImpl,
    config: {
      mode: 'both',
      repos: [{ repo: 'octocat/hello', branch: '', releases: true, enabled: true }],
    },
    summarize: async () => '摘要',
  });
  try {
    await f.tracker.pollNow();
    await f.tracker.pollNow();
    assert.equal(f.sent.length, 2); // 重叠订阅只产生一个事件

    f.tracker.saveConfig({ authors: [] });
    const snap = f.tracker.snapshot();
    assert.equal(snap.config.repos.length, 1);
    assert.equal(snap.authorRepos.length, 0);
    assert.equal(
      (f.store.db
        .prepare("SELECT COUNT(*) AS c FROM github_repos WHERE repo='octocat/hello'")
        .get() as { c: number }).c,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test('作者 ReleaseEvent 与仓库 Release 同一版本只发一条', async () => {
  const fake = fakeAuthorRepoGithub(
    {
      octocat: [
        { body: [] },
        {
          body: [
            event('release-dup', 'ReleaseEvent', 'octocat', 'octocat/hello', 1, {
              release: { id: 7, tag_name: 'v1.0.0', name: 'v1.0.0', body: 'notes', prerelease: false },
            }),
          ],
        },
      ],
    },
    { octocat: [{ body: [{ full_name: 'octocat/hello', private: false, size: 1 }] }] },
    {
      commits: [
        { body: [repoCommit('base', 30)] },
        { body: [repoCommit('base', 30)] },
      ],
      releases: [{ body: [] }, { body: [repoRelease(7, 'v1.0.0', 1, { body: 'notes' })] }],
    },
  );
  const f = fixture({
    fetchImpl: fake.fetchImpl,
    config: { mode: 'authors', repos: [] },
    summarize: async () => '版本摘要',
  });
  try {
    await f.tracker.pollNow();
    await f.tracker.pollNow();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[0]!.text, /🚀 发布 v1\.0\.0/);
    assert.match(f.sent[0]!.text, /版本摘要/);
    const rows = f.store.db
      .prepare('SELECT type,dedupe_key FROM github_events')
      .all() as unknown as Array<{ type: string; dedupe_key: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.type, 'RepoRelease');
    assert.equal(rows[0]!.dedupe_key, 'release:octocat/hello:7');
  } finally {
    await f.dispose();
  }
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
    assert.equal(f.calls.length, 4);
    // If-None-Match 应该带上上一轮的 ETag
    assert.equal(f.sent.length, 0);

    // 第三轮：有新事件且限额归零
    const limited = await f.tracker.pollNow();
    assert.equal(limited.fetched, 1);
    assert.equal(limited.delivered, 1);

    const blocked = await f.tracker.pollNow();
    assert.equal(f.calls.length, 6); // 限额用尽后不再请求 GitHub
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

test('保存 Token 后清掉旧的匿名限额阻塞，并立即用新凭证重试', async () => {
  const reset = Math.floor(NOW / 1000) + 3600;
  const f = fixture({
    plan: {
      octocat: [
        {
          body: [],
          headers: {
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(reset),
          },
        },
        { body: [] },
      ],
    },
  });
  try {
    await f.tracker.pollNow();
    assert.equal(f.tracker.snapshot().runtime.rate.remaining, 0);
    assert.equal(f.tracker.snapshot().runtime.rate.limit, 60);

    const blocked = await f.tracker.pollNow();
    assert.equal(blocked.ok, false);
    assert.equal(f.calls.length, 2);
    assert.ok(blocked.errors.some((message) => message.includes('限额')));
    f.tracker.saveConfig({ token: 'ghp_new_token_value' });
    const resetSnapshot = f.tracker.snapshot();
    assert.equal(resetSnapshot.runtime.rate.remaining, null);
    assert.equal(resetSnapshot.runtime.rate.limit, null);
    assert.equal(resetSnapshot.runtime.lastError, '');

    const after = await f.tracker.pollNow();
    assert.equal(after.ok, true);
    assert.equal(f.calls.length, 4);
  } finally {
    await f.dispose();
  }
});

test('配置 Token 后请求带 Authorization，面板快照不泄漏 Token', async () => {
  let authorization = '';
  const f = fixture({
    config: { token: 'ghp_secret_value' },
    fetchImpl: async (_url, init) => {
      authorization = init?.headers?.['authorization'] ?? '';
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [],
        text: async () => '',
      };
    },
  });
  try {
    await f.tracker.pollNow();
    assert.equal(authorization, 'Bearer ghp_secret_value');
    assert.equal(JSON.stringify(f.tracker.snapshot()).includes('ghp_secret_value'), false);
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

    const repoGood = await app.request('/api/github/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'both',
        aiSummary: false,
        repoDiscoverySec: 7200,
        repos: [{ repo: 'owner/repo', branch: 'main', releases: true }],
      }),
    });
    assert.equal(repoGood.status, 200);
    const savedRepo = (await json(repoGood)) as {
      config: {
        mode: string;
        aiSummary: boolean;
        repoDiscoverySec: number;
        repos: Array<{ repo: string; branch: string }>;
      };
    };
    assert.equal(savedRepo.config.mode, 'both');
    assert.equal(savedRepo.config.aiSummary, false);
    assert.equal(savedRepo.config.repoDiscoverySec, 7200);
    assert.equal(savedRepo.config.repos[0]!.repo, 'owner/repo');
    assert.equal(savedRepo.config.repos[0]!.branch, 'main');

    const repoState = (await json(await app.request('/api/github/state'))) as {
      repos: Array<{ repo: string; branch: string }>;
    };
    assert.equal(repoState.repos[0]!.repo, 'owner/repo');
    assert.equal(repoState.repos[0]!.branch, 'main');
  } finally {
    await f.dispose();
  }
});

test('面板含 GitHub 追踪页，内嵌脚本可编译', () => {
  const html = fs.readFileSync('src/web/panel.html', 'utf8');
  assert.match(html, /data-page="github"/);
  assert.match(html, /id="page-github"/);
  assert.match(html, /id="gh_settings"/);
  assert.match(html, /id="gh_mode"/);
  assert.match(html, /gh_repoDiscovery/);
  assert.match(html, /id="gh_aiSummary"/);
  assert.match(html, /id="gh_authorRepos"/);
  assert.match(html, /id="gh_tokenState"/);
  assert.match(html, /ghTokenInput/);
  assert.match(html, /保存 Token/);
  assert.match(html, /用 AI 总结更新内容/);
  assert.match(html, /id="gh_repos"/);
  assert.match(html, /function renderGithubRepos/);
  assert.match(html, /\/api\/github\/state/);
  assert.match(html, /\/api\/github\/config/);
  // 「下次检查」必须是独立的节点，由 1 秒定时器本地刷新，而不是只在 10 秒拉取时重算
  assert.match(html, /id="gh_nextPoll"/);
  assert.match(html, /function updateGithubCountdown/);
  assert.match(html, /setInterval\(updateGithubCountdown, 1000\)/);
  // 设置改动后自动保存并热更新，而不是必须手动点保存
  assert.match(html, /GH_AUTO_SAVE_MS/);
  assert.match(html, /saveGithubConfig\(true\)/);
  assert.match(html, /自动保存中/);
  assert.match(html, /if \(ghDirty && ghState\)/);
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const script of scripts) new vm.Script(script[1]!);
});
