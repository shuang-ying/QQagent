/**
 * GitHub 事件解析与消息排版
 *
 * 纯函数，不碰网络和数据库，便于单测。
 *
 * 重要安全约定：
 *  接口返回的提交信息、PR 标题、发行说明等都是**不可信文本**，可能包含 OneBot 的
 *  CQ 码片段（例如 `[CQ:at,qq=all]`）。这里只负责把文本清理成单行并截断；
 *  真正发送时必须走消息段数组（text 段），由 toCqCodes 做 `&`/`[`/`]` 转义，
 *  绝不能用原始字符串直接发。
 */
import { GITHUB_EVENT_LABELS, type GithubEventType } from './config.js';

export interface GithubEventDto {
  id: string;
  type: string;
  login: string;
  repo: string;
  createdAt: number;
  payload: Record<string, unknown>;
}

export interface RenderedGithubEvent {
  /** 单行摘要，用于面板表格 */
  summary: string;
  /** 完整消息正文（多行） */
  text: string;
  url: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 清理不可信文本：去掉控制字符、折叠空白、截断 */
export function cleanGithubText(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 逐级读取嵌套字段；任何一层不是对象就返回 undefined */
function fieldOf(root: unknown, ...path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 只接受 http(s) 链接，避免把奇怪协议塞进聊天窗口 */
export function safeGithubUrl(value: unknown): string {
  const raw = cleanGithubText(value, 500);
  if (!raw || /\s/.test(raw)) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function encodeRef(ref: string): string {
  return ref.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function repoWebUrl(repo: string): string {
  return repo ? `https://github.com/${repo}` : '';
}

/** GitHub Events API 的一条事件 -> 内部结构；缺关键字段时返回 null */
export function parseGithubEvent(raw: unknown): GithubEventDto | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
  const type = typeof raw['type'] === 'string' ? raw['type'].trim() : '';
  const actor = raw['actor'];
  const login = isRecord(actor) && typeof actor['login'] === 'string' ? actor['login'].trim() : '';
  const repoRaw = raw['repo'];
  const repo = isRecord(repoRaw) && typeof repoRaw['name'] === 'string' ? repoRaw['name'].trim() : '';
  const createdAt = typeof raw['created_at'] === 'string' ? Date.parse(raw['created_at']) : NaN;
  if (!id || !type || !login || !Number.isFinite(createdAt)) return null;
  const payload = isRecord(raw['payload']) ? raw['payload'] : {};
  return { id, type, login, repo, createdAt, payload };
}

function describeEvent(ev: GithubEventDto): { summary: string; details: string[]; url: string } {
  const repo = cleanGithubText(ev.repo, 120) || '未知仓库';
  const payload = ev.payload;
  const fallbackUrl = repoWebUrl(ev.repo);

  switch (ev.type as GithubEventType) {
    case 'PushEvent': {
      const commits = Array.isArray(fieldOf(payload, 'commits')) ? (fieldOf(payload, 'commits') as unknown[]) : [];
      const size = Number(fieldOf(payload, 'size'));
      const count = Number.isFinite(size) && size > 0 ? size : commits.length;
      const branch = cleanGithubText(fieldOf(payload, 'ref'), 80).replace(/^refs\/heads\//, '');
      const details: string[] = [];
      if (branch) details.push(`分支：${branch}`);
      for (const commit of commits.slice(0, 3)) {
        const message = cleanGithubText(fieldOf(commit, 'message'), 80);
        if (message) details.push(message);
      }
      if (commits.length > 3) details.push(`…共 ${commits.length} 条提交`);
      const sha = cleanGithubText(fieldOf(payload, 'head'), 40);
      const url = /^[0-9a-f]{7,40}$/i.test(sha) ? `${fallbackUrl}/commit/${sha}` : fallbackUrl;
      return { summary: `🚀 推送 ${count} 个提交到 ${repo}`, details, url };
    }

    case 'CreateEvent': {
      const refType = cleanGithubText(fieldOf(payload, 'ref_type'), 30);
      const ref = cleanGithubText(fieldOf(payload, 'ref'), 80);
      if (refType === 'repository') return { summary: `🆕 新建仓库 ${repo}`, details: [], url: fallbackUrl };
      if (refType === 'branch') {
        return { summary: `🌿 新建分支 ${ref} · ${repo}`, details: [], url: `${fallbackUrl}/tree/${encodeRef(ref)}` };
      }
      if (refType === 'tag') {
        return { summary: `🏷 新建标签 ${ref} · ${repo}`, details: [], url: `${fallbackUrl}/releases/tag/${encodeRef(ref)}` };
      }
      return { summary: `🆕 新建 ${refType || '内容'}${ref ? `：${ref}` : ''} · ${repo}`, details: [], url: fallbackUrl };
    }

    case 'DeleteEvent': {
      const refType = cleanGithubText(fieldOf(payload, 'ref_type'), 30);
      const ref = cleanGithubText(fieldOf(payload, 'ref'), 80);
      const label = refType === 'branch' ? '分支' : refType === 'tag' ? '标签' : refType || '引用';
      return { summary: `🗑 删除${label} ${ref} · ${repo}`, details: [], url: fallbackUrl };
    }

    case 'ReleaseEvent': {
      const release = fieldOf(payload, 'release');
      const tag = cleanGithubText(fieldOf(release, 'tag_name'), 60);
      const name = cleanGithubText(fieldOf(release, 'name'), 80);
      const body = cleanGithubText(fieldOf(release, 'body'), 120);
      const prerelease = fieldOf(release, 'prerelease') === true;
      const details: string[] = [];
      if (name && name !== tag) details.push(name);
      if (body) details.push(body);
      return {
        summary: `${prerelease ? '🧪 预发布' : '🚀 发布'} ${tag || name} · ${repo}`,
        details,
        url: safeGithubUrl(fieldOf(release, 'html_url')) || fallbackUrl,
      };
    }

    case 'PullRequestEvent': {
      const pr = fieldOf(payload, 'pull_request');
      const number = Number(fieldOf(payload, 'number')) || Number(fieldOf(pr, 'number'));
      const title = cleanGithubText(fieldOf(pr, 'title'), 120);
      const action = cleanGithubText(fieldOf(payload, 'action'), 20);
      const merged = fieldOf(pr, 'merged') === true;
      const label = `#${Number.isFinite(number) && number > 0 ? number : '?'}`;
      let summary: string;
      if (action === 'opened') summary = `🔀 打开 PR ${label} · ${repo}`;
      else if (action === 'closed' && merged) summary = `✅ 合并 PR ${label} · ${repo}`;
      else if (action === 'closed') summary = `🚫 关闭 PR ${label} · ${repo}`;
      else if (action === 'reopened') summary = `🔄 重新打开 PR ${label} · ${repo}`;
      else summary = `🔀 PR ${label} ${action || '更新'} · ${repo}`;
      return { summary, details: title ? [title] : [], url: safeGithubUrl(fieldOf(pr, 'html_url')) || fallbackUrl };
    }

    case 'PullRequestReviewEvent': {
      const pr = fieldOf(payload, 'pull_request');
      const number = Number(fieldOf(payload, 'number')) || Number(fieldOf(pr, 'number'));
      const title = cleanGithubText(fieldOf(pr, 'title'), 120);
      const state = cleanGithubText(fieldOf(payload, 'review', 'state'), 30);
      const stateLabel = state === 'approved' ? '（通过）' : state === 'changes_requested' ? '（请求修改）' : '（有评论）';
      const label = `#${Number.isFinite(number) && number > 0 ? number : '?'}`;
      return {
        summary: `🔍 评审 PR ${label}${stateLabel} · ${repo}`,
        details: title ? [title] : [],
        url: safeGithubUrl(fieldOf(pr, 'html_url')) || fallbackUrl,
      };
    }

    case 'IssuesEvent': {
      const issue = fieldOf(payload, 'issue');
      const number = Number(fieldOf(payload, 'number')) || Number(fieldOf(issue, 'number'));
      const title = cleanGithubText(fieldOf(issue, 'title'), 120);
      const action = cleanGithubText(fieldOf(payload, 'action'), 20);
      const label = `#${Number.isFinite(number) && number > 0 ? number : '?'}`;
      const prefix = action === 'opened' ? '📌 新建 Issue' : action === 'closed' ? '✅ 关闭 Issue' : action === 'reopened' ? '🔄 重新打开 Issue' : `📌 Issue ${action || '更新'}`;
      return {
        summary: `${prefix} ${label} · ${repo}`,
        details: title ? [title] : [],
        url: safeGithubUrl(fieldOf(issue, 'html_url')) || fallbackUrl,
      };
    }

    case 'IssueCommentEvent': {
      const issue = fieldOf(payload, 'issue');
      const comment = fieldOf(payload, 'comment');
      const number = Number(fieldOf(issue, 'number'));
      const title = cleanGithubText(fieldOf(issue, 'title'), 120);
      const body = cleanGithubText(fieldOf(comment, 'body'), 100);
      const action = cleanGithubText(fieldOf(payload, 'action'), 20);
      const label = `#${Number.isFinite(number) && number > 0 ? number : '?'}`;
      const prefix = action === 'created' ? '💬 评论 Issue' : '💬 更新评论 Issue';
      return {
        summary: `${prefix} ${label} · ${repo}`,
        details: [title, body].filter(Boolean),
        url: safeGithubUrl(fieldOf(comment, 'html_url')) || fallbackUrl,
      };
    }

    case 'CommitCommentEvent': {
      const comment = fieldOf(payload, 'comment');
      const sha = cleanGithubText(fieldOf(comment, 'commit_id'), 40).slice(0, 7);
      const body = cleanGithubText(fieldOf(comment, 'body'), 100);
      const path = cleanGithubText(fieldOf(comment, 'path'), 80);
      return {
        summary: `💬 评论提交${sha ? ` ${sha}` : ''} · ${repo}`,
        details: [path ? `文件：${path}` : '', body].filter(Boolean),
        url: safeGithubUrl(fieldOf(comment, 'html_url')) || fallbackUrl,
      };
    }

    case 'ForkEvent': {
      const forkee = fieldOf(payload, 'forkee');
      const forkName = cleanGithubText(fieldOf(forkee, 'full_name'), 120) || repo;
      return {
        summary: `🍴 Fork ${repo} → ${forkName}`,
        details: [],
        url: safeGithubUrl(fieldOf(forkee, 'html_url')) || fallbackUrl,
      };
    }

    case 'WatchEvent':
      return { summary: `⭐ Star ${repo}`, details: [], url: fallbackUrl };

    case 'PublicEvent':
      return { summary: `🌍 仓库转为公开 ${repo}`, details: [], url: fallbackUrl };

    case 'MemberEvent': {
      const action = cleanGithubText(fieldOf(payload, 'action'), 20);
      const member = cleanGithubText(fieldOf(payload, 'member', 'login'), 60);
      return {
        summary: `👥 ${action === 'removed' ? '移除' : '添加'}协作者 ${member || '(未知)'} · ${repo}`,
        details: [],
        url: fallbackUrl,
      };
    }

    case 'GollumEvent': {
      const pages = Array.isArray(fieldOf(payload, 'pages')) ? (fieldOf(payload, 'pages') as unknown[]) : [];
      const names = pages.slice(0, 3).map((page) => cleanGithubText(fieldOf(page, 'page_name'), 60)).filter(Boolean);
      return {
        summary: `📖 更新 Wiki${pages.length ? `（${pages.length} 页）` : ''} · ${repo}`,
        details: names,
        url: fallbackUrl,
      };
    }

    case 'DiscussionEvent': {
      const discussion = fieldOf(payload, 'discussion');
      const number = Number(fieldOf(discussion, 'number'));
      const title = cleanGithubText(fieldOf(discussion, 'title'), 120);
      const label = `#${Number.isFinite(number) && number > 0 ? number : '?'}`;
      return {
        summary: `💬 讨论 ${label} · ${repo}`,
        details: title ? [title] : [],
        url: safeGithubUrl(fieldOf(discussion, 'html_url')) || fallbackUrl,
      };
    }

    default:
      return {
        summary: `📌 ${cleanGithubText(GITHUB_EVENT_LABELS[ev.type as GithubEventType] || ev.type, 60)} · ${repo}`,
        details: [],
        url: fallbackUrl,
      };
  }
}

/** 组装成一条可发送的 QQ 文本消息 */
export function renderGithubEvent(ev: GithubEventDto, timezone: string): RenderedGithubEvent {
  const described = describeEvent(ev);
  const lines = [`📡 GitHub · ${cleanGithubText(ev.login, 39)}`, described.summary];
  for (const detail of described.details) lines.push(`· ${detail}`);
  if (described.url) lines.push(`🔗 ${described.url}`);
  lines.push(`🕐 ${formatGithubTime(ev.createdAt, timezone)}`);
  return { summary: described.summary, text: lines.join('\n'), url: described.url };
}

/** 应用时区下的可读时间；时区非法时退回 UTC */
export function formatGithubTime(timestamp: number, timezone: string): string {
  try {
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(timestamp));
    return formatted.replace(/\//g, '-');
  } catch {
    return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
  }
}

export interface RepoCommitInfo {
  sha: string;
  author: string;
  message: string;
}

export interface RepoPushInfo {
  repo: string;
  branch: string;
  total: number;
  commits: RepoCommitInfo[];
  url: string;
  occurredAt: number;
}

/** 追加 AI 总结：最多 4 行，单行截断，保持纯文本 */
function appendAiSummary(lines: string[], aiSummary: string | undefined): void {
  const cleaned = String(aiSummary ?? '')
    .split(/\r?\n/)
    .map((line) => cleanGithubText(line.replace(/^\s*[-*•]\s*/, ''), 120))
    .filter(Boolean)
    .slice(0, 4);
  if (!cleaned.length) return;
  lines.push('🤖 AI 总结');
  for (const line of cleaned) lines.push(`· ${line}`);
}

/** 仓库订阅：一个分支 HEAD 变化后的新提交汇总 */
export function renderRepoPush(
  info: RepoPushInfo,
  timezone: string,
  aiSummary = '',
): RenderedGithubEvent {
  const repo = cleanGithubText(info.repo, 120) || '未知仓库';
  const branch = cleanGithubText(info.branch, 80) || '默认分支';
  const total = Math.max(1, Math.trunc(info.total) || info.commits.length || 1);
  const lines = [`📦 GitHub 仓库 · ${repo}`, `🚀 ${branch} 有 ${total} 个新提交`];
  const shown = info.commits.slice(0, 5);
  for (const commit of shown) {
    const sha = cleanGithubText(commit.sha, 40).slice(0, 7);
    const author = cleanGithubText(commit.author, 40) || '未知作者';
    const firstLine = String(commit.message ?? '').split(/\r?\n/)[0] ?? '';
    const message = cleanGithubText(firstLine, 80);
    lines.push(`· ${sha} @${author}${message ? `：${message}` : ''}`);
  }
  const hidden = total - shown.length;
  if (hidden > 0) lines.push(`· …另有 ${hidden} 条提交`);
  const url = safeGithubUrl(info.url);
  if (url) lines.push(`🔗 ${url}`);
  lines.push(`🕐 ${formatGithubTime(info.occurredAt, timezone)}`);
  appendAiSummary(lines, aiSummary);
  return {
    summary: `🚀 ${repo} ${branch} +${total} 提交`,
    text: lines.join('\n'),
    url,
  };
}

export interface RepoReleaseInfo {
  tag: string;
  name: string;
  body: string;
  prerelease: boolean;
  url: string;
  publishedAt: number;
}

/** 仓库订阅：GitHub Release 新版本 */
export function renderRepoRelease(
  repoName: string,
  release: RepoReleaseInfo,
  timezone: string,
  aiSummary = '',
): RenderedGithubEvent {
  const repo = cleanGithubText(repoName, 120) || '未知仓库';
  const tag = cleanGithubText(release.tag, 60) || '未知版本';
  const name = cleanGithubText(release.name, 80);
  const body = cleanGithubText(release.body, 120);
  const lines = [`📦 GitHub 仓库 · ${repo}`, `${release.prerelease ? '🧪 预发布' : '🚀 发布'} ${tag}`];
  if (name && name !== tag) lines.push(`· ${name}`);
  if (body) lines.push(`· ${body}`);
  const url = safeGithubUrl(release.url);
  if (url) lines.push(`🔗 ${url}`);
  lines.push(`🕐 ${formatGithubTime(release.publishedAt, timezone)}`);
  appendAiSummary(lines, aiSummary);
  return {
    summary: `${release.prerelease ? '🧪' : '🚀'} ${tag} · ${repo}`,
    text: lines.join('\n'),
    url,
  };
}

export function renderGithubTestMessage(timezone: string, now = Date.now()): string {
  return [
    '📡 GitHub 动态追踪测试',
    '如果你看到这条消息，说明这个会话已经成功接入推送。',
    `🕐 ${formatGithubTime(now, timezone)}`,
  ].join('\n');
}
