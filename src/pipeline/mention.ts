/**
 * @人 的处理
 *
 * ## 为什么需要这个
 *
 * 原来 @ 谁是写死的：**永远 @ 触发这条消息的人**。
 * 被动回复时这是对的（对方 @ 了机器人，机器人回他）。
 * 但**主动搭话**时"触发者"只是"最近最后说话的人"，跟机器人实际在回应谁
 * 往往不是同一个人：
 *
 *   张三：这个功能好像有 bug
 *   李四：哈哈哈
 *           ← 机器人插话，内容在说张三的 bug，@ 却给了李四
 *
 * 所以主动搭话时必须让**模型自己说清楚在跟谁说话**，
 * 这里用跟 `[表情:标签]` 同一套思路：给模型一个受控的表达通道 `[@名字]`。
 *
 * ## 约定
 *
 * - 模型写 `[@张三]` → 系统解析成真正的 @ 段（并顺手引用他那条消息）
 * - 不写 → 被动回复沿用"@当前说话人"；主动搭话则**谁都不 @**
 * - 写了但名字对不上 → 谁都不 @（宁可少 @，也不要 @ 错人）
 */
import type { ObMessageSegment } from '../core/types.js';

/** 模型用来指定 @ 对象的标记，如 [@张三] */
export const MENTION_MARKER_RE = /\[\s*@\s*([^\]\n]{1,40}?)\s*\]/g;

/** 最近发过言的群成员 */
export interface Participant {
  userId: number;
  name: string;
  /** 他最后一条消息的 id，用于引用回复 */
  messageId?: number;
}

export interface MentionResolution {
  /** 去掉标记后的正文 */
  text: string;
  /** 模型**是否**写过标记（写了对不上也算写了） */
  hadMarker: boolean;
  /** 解析成功的目标；对不上时为 undefined */
  target?: Participant;
  /** 模型写的原始名字，便于日志排查 */
  requested?: string;
}

/**
 * 从回复正文里摘出 `[@名字]` 并解析成具体的人。
 *
 * 注意：**只要写了标记就一定从正文里摘掉**，哪怕名字对不上 ——
 * 让 `[@张三]` 这种控制标记原样发到群里比不 @ 人更糟。
 */
export function extractMention(text: string, participants: Participant[]): MentionResolution {
  let requested: string | undefined;
  let hadMarker = false;

  const cleaned = text.replace(MENTION_MARKER_RE, (_m, raw: string) => {
    hadMarker = true;
    if (requested === undefined) requested = String(raw).trim();
    return '';
  });

  if (!hadMarker) return { text, hadMarker: false };

  // 标记常写在开头，摘掉后可能留下行首空白
  const out = cleaned.replace(/^[ \t]+/gm, '').trim();
  const target = requested ? resolveMention(requested, participants) : undefined;

  return {
    text: out,
    hadMarker: true,
    ...(target ? { target } : {}),
    ...(requested ? { requested } : {}),
  };
}

/** @全体成员 之类一律拒绝：太吵，而且容易被滥用 */
const FORBIDDEN = new Set(['all', '全体成员', '所有人', '大家', '全体', 'everyone', '@all']);

/**
 * 把模型写的名字解析成群成员。
 * 依次尝试：精确 → 忽略大小写/空白 → 包含关系。
 * 重名和多个匹配都不猜测；QQ号唯一匹配优先。
 */
export function resolveMention(name: string, participants: Participant[]): Participant | undefined {
  const raw = name.trim().replace(/^@/, '').trim();
  if (!raw) return undefined;
  if (FORBIDDEN.has(raw.toLowerCase())) return undefined;

  // 1) 精确
  if (/^\d+$/.test(raw)) return participants.find(p => p.userId === Number(raw));
  const exact = participants.filter((p) => p.name === raw);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;

  // 2) 忽略大小写与空白（群名片里常有全角空格之类）
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const n = norm(raw);
  const ci = participants.filter((p) => norm(p.name) === n);
  if (ci.length) return ci.length === 1 ? ci[0] : undefined;

  // 3) 包含：模型可能只写了名字的一部分，或带上了后缀
  const partial = participants.filter((p) => {
    const pn = norm(p.name);
    return pn.length > 0 && (pn.includes(n) || n.includes(pn));
  });
  if (partial.length === 1) return partial[0];
  // 多个都匹配时不要猜 —— 猜错就等于 @ 错人，正是要修的问题
  return undefined;
}

/**
 * 给提示词用的成员清单。
 * `lastSpeakerId` 用来标出"最后说话的人"，帮模型分清谁是新消息。
 */
export function describeParticipants(
  participants: Participant[],
  lastSpeakerId?: number,
  requesterId?: number,
): string {
  if (participants.length === 0) return '';
  const lines = ['', '【群里的人（最近发过言的）】'];
  for (const p of participants) {
    const mark = (p.userId === lastSpeakerId ? '  ← 最后说话的人' : '') + (p.userId === requesterId ? '  ← 本轮回复对象' : '');
    lines.push(`- ${p.name}（QQ ${p.userId}）${mark}`);
  }
  lines.push(
    '',
    '如果针对某个人说话，在正文最前面写 [@QQ号]，例如 [@123456]；QQ号必须来自上面清单，系统会替你 @ 他。',
    '- 名字必须用上面列出的，不要用昵称简称或自己编。',
    '- 主动插话、只是对大家说话时，**不要**写这个标记。',
    '- 标记只写在最前面，不要写进正文中间，也不要写多个。',
  );
  return lines.join('\n');
}

/** 从消息段里取 @ 的对象（备用：需要从入站消息反查时用） */
export function mentionedIds(segments: ObMessageSegment[]): number[] {
  const out: number[] = [];
  for (const s of segments) {
    if (s.type !== 'at') continue;
    const qq = Number(s.data?.['qq']);
    if (Number.isFinite(qq)) out.push(qq);
  }
  return out;
}
