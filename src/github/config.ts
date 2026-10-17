/**
 * GitHub 动态追踪：配置模型、校验与本地配置文件读写
 *
 * 配置放在独立的 config/github.yaml，而不是 app.yaml：
 *  - 作者列表与推送会话是本功能页自己的数据，增删频繁，不适合塞进主配置
 *  - 可选的 GitHub Token 属于私密信息，单独一个文件更容易在 .gitignore 里隔离
 *  - 面板保存时整文件重写（同 personas），不会破坏 app.yaml 里的注释
 *
 * 校验顺序固定为「先归一化、再走 zod」：
 *  归一化负责给出中文错误提示和去重，zod 负责最后一道结构兜底。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { atomicWrite } from '../config/atomic.js';

/** 支持推送的公开事件类型（GitHub Events API 的 type 字段） */
export const GITHUB_EVENT_TYPES = [
  'PushEvent',
  'CreateEvent',
  'DeleteEvent',
  'ReleaseEvent',
  'PullRequestEvent',
  'PullRequestReviewEvent',
  'IssuesEvent',
  'IssueCommentEvent',
  'CommitCommentEvent',
  'ForkEvent',
  'WatchEvent',
  'PublicEvent',
  'MemberEvent',
  'GollumEvent',
  'DiscussionEvent',
] as const;
export type GithubEventType = (typeof GITHUB_EVENT_TYPES)[number];

export const GITHUB_EVENT_LABELS: Record<GithubEventType, string> = {
  PushEvent: '推送代码',
  CreateEvent: '新建仓库 / 分支 / 标签',
  DeleteEvent: '删除分支 / 标签',
  ReleaseEvent: '发布版本',
  PullRequestEvent: 'Pull Request',
  PullRequestReviewEvent: 'PR 评审',
  IssuesEvent: 'Issue',
  IssueCommentEvent: 'Issue 评论',
  CommitCommentEvent: '提交评论',
  ForkEvent: 'Fork',
  WatchEvent: 'Star',
  PublicEvent: '仓库转为公开',
  MemberEvent: '添加协作者',
  GollumEvent: 'Wiki 更新',
  DiscussionEvent: '讨论',
};

/** 默认只推「作者本人做了什么」的事件，避免噪音 */
export const DEFAULT_GITHUB_EVENT_TYPES: GithubEventType[] = [
  'PushEvent',
  'CreateEvent',
  'ReleaseEvent',
  'PullRequestEvent',
  'PullRequestReviewEvent',
  'IssuesEvent',
  'IssueCommentEvent',
  'ForkEvent',
  'WatchEvent',
  'PublicEvent',
];

export const GITHUB_AUTHOR_LIMIT = 50;
export const GITHUB_TARGET_LIMIT = 50;
export const GITHUB_MAX_EVENTS_PER_POLL = 20;
export const GITHUB_MAX_EVENT_AGE_HOURS = 168;

/** GitHub 用户名：1~39 个字母数字或短横线，不能以短横线开头/结尾 */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** 会话：group:群号 / private:QQ号，4~12 位数字（与 trigger 白名单一致） */
const SCOPE_RE = /^(group|private):([1-9]\d{3,11})$/;

export const GithubAuthorSchema = z.object({
  login: z.string().min(1).max(39),
  enabled: z.boolean().default(true),
});

export const GithubTargetSchema = z.object({
  scope: z.string().regex(/^(group|private):[1-9]\d{3,11}$/),
  enabled: z.boolean().default(true),
});

export const GithubConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** 轮询间隔（秒）；GitHub 官方建议轮询不要太频繁 */
  intervalSec: z.number().int().min(60).max(3600).default(300),
  /** 单个作者每轮最多推送多少条，超出的下一轮继续 */
  maxEventsPerPoll: z.number().int().min(1).max(GITHUB_MAX_EVENTS_PER_POLL).default(5),
  /** 超过这个时长的旧动态直接忽略，避免停机后补发陈年事件 */
  maxEventAgeHours: z.number().int().min(1).max(GITHUB_MAX_EVENT_AGE_HOURS).default(24),
  /** GitHub API 基址（GitHub Enterprise 可改） */
  apiBase: z.string().max(300).default('https://api.github.com'),
  /** 可选 Token：不填时匿名请求 60 次/小时，填了 5000 次/小时 */
  token: z.string().max(500).default(''),
  eventTypes: z.array(z.enum(GITHUB_EVENT_TYPES)).max(GITHUB_EVENT_TYPES.length).default([...DEFAULT_GITHUB_EVENT_TYPES]),
  authors: z.array(GithubAuthorSchema).max(GITHUB_AUTHOR_LIMIT).default([]),
  targets: z.array(GithubTargetSchema).max(GITHUB_TARGET_LIMIT).default([]),
});

export type GithubConfig = z.infer<typeof GithubConfigSchema>;
export type GithubAuthorConfig = z.infer<typeof GithubAuthorSchema>;
export type GithubTargetConfig = z.infer<typeof GithubTargetSchema>;

/** 面板可见的配置：永不返回 Token 明文，只告诉前端有没有设置 */
export type PublicGithubConfig = Omit<GithubConfig, 'token'> & { tokenSet: boolean };

export function defaultGithubConfig(): GithubConfig {
  return GithubConfigSchema.parse({});
}

export function publicGithubConfig(config: GithubConfig): PublicGithubConfig {
  const { token, ...rest } = config;
  void token;
  return { ...rest, tokenSet: config.token.length > 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integerValue(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${label}需要是整数`);
  }
  if (n < min || n > max) throw new Error(`${label}需要在 ${min}~${max} 之间`);
  return n;
}

function normalizeApiBase(value: unknown): string {
  if (typeof value !== 'string') throw new Error('apiBase 需要是字符串');
  const raw = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(raw) || raw.length > 300) {
    throw new Error('apiBase 需要是 http(s) 开头的地址');
  }
  return raw;
}

function normalizeToken(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Token 需要是字符串');
  const token = value.trim();
  if (token.length > 500) throw new Error('Token 过长（最多 500 字符）');
  if (/\s/.test(token)) throw new Error('Token 不能包含空白字符');
  return token;
}

function normalizeEventTypes(value: unknown): GithubEventType[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，\s]+/).filter(Boolean)
      : null;
  if (!list) throw new Error('eventTypes 需要是数组');
  const out: GithubEventType[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const name = String(item).trim();
    if (!name) continue;
    if (!(GITHUB_EVENT_TYPES as readonly string[]).includes(name)) {
      throw new Error(`不支持的事件类型「${name}」`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name as GithubEventType);
  }
  return out;
}

function normalizeAuthors(value: unknown): GithubAuthorConfig[] {
  if (!Array.isArray(value)) throw new Error('追踪的作者需要是数组');
  const out: GithubAuthorConfig[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const raw = typeof item === 'string' ? { login: item } : item;
    if (!isRecord(raw)) throw new Error('作者条目格式不正确');
    const login = String(raw['login'] ?? '').trim();
    if (!LOGIN_RE.test(login)) {
      throw new Error(`GitHub 用户名「${login}」不合法（1~39 位字母、数字或短横线，且不能以短横线开头/结尾）`);
    }
    const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true;
    const key = login.toLowerCase();
    if (seen.has(key)) continue; // GitHub 用户名大小写不敏感，按小写去重
    seen.add(key);
    out.push({ login, enabled });
  }
  if (out.length > GITHUB_AUTHOR_LIMIT) throw new Error(`最多同时追踪 ${GITHUB_AUTHOR_LIMIT} 个作者`);
  return out;
}

function normalizeTargets(value: unknown): GithubTargetConfig[] {
  if (!Array.isArray(value)) throw new Error('推送会话需要是数组');
  const out: GithubTargetConfig[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const raw = typeof item === 'string' ? { scope: item } : item;
    if (!isRecord(raw)) throw new Error('会话条目格式不正确');
    const scope = String(raw['scope'] ?? '').trim();
    if (!SCOPE_RE.test(scope)) {
      throw new Error(`会话「${scope}」不合法，应为 group:群号 或 private:QQ号`);
    }
    const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true;
    if (seen.has(scope)) continue;
    seen.add(scope);
    out.push({ scope, enabled });
  }
  if (out.length > GITHUB_TARGET_LIMIT) throw new Error(`最多同时推送到 ${GITHUB_TARGET_LIMIT} 个会话`);
  return out;
}

/**
 * 校验一组面板改动。
 *
 * `input` 是部分配置（面板只传它改动的字段）；未出现的字段沿用 `current`。
 * 返回归一化后的完整配置，可直接写盘。
 */
export function validateGithubConfig(
  input: unknown,
  current: GithubConfig,
): { ok: true; config: GithubConfig } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: '配置必须是 JSON 对象' };

  const config: GithubConfig = {
    ...current,
    eventTypes: [...current.eventTypes],
    authors: current.authors.map((a) => ({ ...a })),
    targets: current.targets.map((t) => ({ ...t })),
  };

  try {
    if (input['enabled'] !== undefined) {
      if (typeof input['enabled'] !== 'boolean') throw new Error('启用开关需要是布尔值');
      config.enabled = input['enabled'];
    }
    if (input['intervalSec'] !== undefined) {
      config.intervalSec = integerValue(input['intervalSec'], '轮询间隔', 60, 3600);
    }
    if (input['maxEventsPerPoll'] !== undefined) {
      config.maxEventsPerPoll = integerValue(input['maxEventsPerPoll'], '每轮最多推送条数', 1, GITHUB_MAX_EVENTS_PER_POLL);
    }
    if (input['maxEventAgeHours'] !== undefined) {
      config.maxEventAgeHours = integerValue(input['maxEventAgeHours'], '忽略旧动态时长', 1, GITHUB_MAX_EVENT_AGE_HOURS);
    }
    if (input['apiBase'] !== undefined) config.apiBase = normalizeApiBase(input['apiBase']);
    if (input['token'] !== undefined) config.token = normalizeToken(input['token']);
    if (input['eventTypes'] !== undefined) config.eventTypes = normalizeEventTypes(input['eventTypes']);
    if (input['authors'] !== undefined) config.authors = normalizeAuthors(input['authors']);
    if (input['targets'] !== undefined) config.targets = normalizeTargets(input['targets']);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const parsed = GithubConfigSchema.safeParse(config);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.') || '配置'}：${i.message}`).join('；');
    return { ok: false, error: message };
  }
  return { ok: true, config: parsed.data };
}

export function githubConfigPath(root: string): string {
  return path.join(root, 'config', 'github.yaml');
}

/**
 * 读取本地配置。
 *
 * 读取失败不回滚成崩溃：机器人主流程不应该因为一块可选功能的配置坏掉而起不来，
 * 这里返回默认配置 + 警告，交给调用方记日志。
 */
export function loadGithubConfig(root: string): { config: GithubConfig; warning?: string } {
  const file = githubConfigPath(root);
  if (!fs.existsSync(file)) return { config: defaultGithubConfig() };
  try {
    const raw = parseYaml(fs.readFileSync(file, 'utf8'));
    if (raw === undefined || raw === null) return { config: defaultGithubConfig() };
    const result = validateGithubConfig(raw, defaultGithubConfig());
    if (!result.ok) return { config: defaultGithubConfig(), warning: result.error };
    return { config: result.config };
  } catch (e) {
    return { config: defaultGithubConfig(), warning: (e as Error).message };
  }
}

/** 原子写回 config/github.yaml（面板保存时调用） */
export function saveGithubConfig(root: string, config: GithubConfig): void {
  const file = githubConfigPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = [
    '# GitHub 动态追踪配置：由管理面板「GitHub 追踪」页维护，手改也可以。',
    '# 这里可能包含 GitHub Token（私密信息），config/github.yaml 已在 .gitignore 中，请勿提交。',
    '',
  ].join('\n');
  atomicWrite(file, header + stringifyYaml(config, { lineWidth: 0 }));
}
