/**
 * OneBot 11 消息归一化
 *
 * 把 NapCat 发来的各种格式统一成 InboundMessage：
 *  - message 可能是 CQ 码字符串，也可能是消息段数组（NapCat 两种都可能发）
 *  - 需要剥离 CQ 码得到纯文本
 *  - 需要判断是否 @ 了机器人
 */
import type { InboundMessage, ObMessageEvent, ObMessageSegment, ObNoticeEvent, PokeEvent } from '../core/types.js';

/** CQ 码中的转义字符还原 */
function unescapeCq(s: string): string {
  return s
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

function escapeCq(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

/**
 * 解析 CQ 码字符串为消息段数组
 * 例：`你好[CQ:at,qq=123] [CQ:image,file=abc.jpg]`
 */
export function parseCqCodes(raw: string): ObMessageSegment[] {
  const segments: ObMessageSegment[] = [];
  const re = /\[CQ:([a-zA-Z0-9_]+)((?:,[^,\]]+)*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) {
      const text = unescapeCq(raw.slice(last, m.index));
      if (text) segments.push({ type: 'text', data: { text } });
    }
    const type = m[1]!;
    const data: Record<string, unknown> = {};
    const kvRaw = m[2] ?? '';
    if (kvRaw) {
      for (const pair of kvRaw.split(',')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const k = pair.slice(0, eq).trim();
        const v = unescapeCq(pair.slice(eq + 1));
        if (!k) continue;
        // qq / user_id 之类的数字字段转成 number，方便比较
        data[k] = /^(qq|user_id|group_id|id)$/.test(k) && /^-?\d+$/.test(v) ? Number(v) : v;
      }
    }
    segments.push({ type, data });
    last = re.lastIndex;
  }

  if (last < raw.length) {
    const text = unescapeCq(raw.slice(last));
    if (text) segments.push({ type: 'text', data: { text } });
  }
  return segments;
}

/** 把消息段数组还原成 CQ 码字符串（用于发送） */
export function toCqCodes(segments: ObMessageSegment[]): string {
  return segments
    .map((seg) => {
      if (seg.type === 'text') return escapeCq(String(seg.data['text'] ?? ''));
      const kv = Object.entries(seg.data)
        .map(([k, v]) => `${k}=${escapeCq(String(v))}`)
        .join(',');
      return `[CQ:${seg.type}${kv ? ',' + kv : ''}]`;
    })
    .join('');
}

/**
 * 把消息段转成给 LLM 看的纯文本。
 * 图片/语音等非文字内容用占位符表示，让模型知道"这里有个附件"。
 */
export function segmentsToText(segments: ObMessageSegment[], selfId = 0): string {
  const parts: string[] = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        parts.push(String(seg.data['text'] ?? ''));
        break;
      case 'at': {
        const qq = String(seg.data['qq'] ?? '');
        if (qq === 'all') parts.push('@全体成员');
        else if (Number(qq) === selfId) parts.push('@你');
        else parts.push(`@${seg.data['name'] ?? qq}`);
        break;
      }
      case 'face':
        parts.push(`[表情:${seg.data['id'] ?? ''}]`);
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'file':
        parts.push('[文件]');
        break;
      case 'reply':
        // 引用回复：忽略引用内容本身，不阻塞语义
        break;
      case 'forward':
        parts.push('[合并转发]');
        break;
      case 'json':
      case 'xml':
        parts.push('[卡片消息]');
        break;
      case 'mface':
        parts.push('[表情包]');
        break;
      case 'poke':
        parts.push('[戳一戳]');
        break;
      default:
        parts.push(`[${seg.type}]`);
    }
  }
  return parts.join('').trim();
}

/** 从 message 字段（字符串或数组）得到消息段 */
export function toSegments(message: string | ObMessageSegment[]): ObMessageSegment[] {
  if (Array.isArray(message)) {
    return message.map((s) => ({ type: String(s.type), data: (s.data ?? {}) as Record<string, unknown> }));
  }
  return parseCqCodes(String(message ?? ''));
}

/** 是否 @ 了机器人（消息段方式或文本方式都判断） */
export function detectMention(segments: ObMessageSegment[], selfId: number, rawText: string): boolean {
  for (const seg of segments) {
    if (seg.type === 'at') {
      const qq = String(seg.data['qq'] ?? '');
      if (qq === 'all') return true;
      if (Number(qq) === selfId) return true;
    }
  }
  // 兜底：文本里直接写了 @机器人昵称 或 CQ 码未解析干净
  if (selfId && (rawText.includes(`[CQ:at,qq=${selfId}]`) || rawText.includes(`@${selfId}`))) return true;
  return false;
}

/**
 * 归一化「戳一戳」通知。
 *
 * OneBot 11 各实现对 poke 的字段命名不完全一致，常见的有：
 *   notice_type=poke, sub_type=poke, user_id, target_id
 *   notice_type=notify, sub_type=poke, user_id, target_id
 *   notice_type=friend_poke / group_poke
 * 这里做兼容解析，取不到就返回 null（而不是抛错）。
 */
export function normalizePokeEvent(ev: ObNoticeEvent): PokeEvent | null {
  const noticeType = String(ev['notice_type'] ?? '');
  const subType = String(ev['sub_type'] ?? '');
  const isPoke = noticeType === 'poke' || noticeType.includes('poke') || subType === 'poke';
  if (!isPoke) return null;

  const selfId = Number(ev.self_id) || 0;
  const userId = Number(ev['user_id']) || 0;
  // 群聊里被戳的对象在 target_id；有些实现放在 user_id 上
  const targetId = Number(ev['target_id'] ?? ev['user_id']) || 0;
  if (!userId) return null;

  const groupId = ev['group_id'] !== undefined ? Number(ev['group_id']) : undefined;
  const scopeType: 'private' | 'group' = groupId ? 'group' : 'private';
  const scope = scopeType === 'group' ? `group:${groupId}` : `private:${userId}`;

  return {
    scope,
    scopeType,
    ...(groupId !== undefined ? { groupId } : {}),
    userId,
    targetId,
    selfId,
    senderName: String(ev['sender_name'] ?? ev['nickname'] ?? '') || String(userId),
    timestamp: (Number(ev.time) || Math.floor(Date.now() / 1000)) * 1000,
  };
}

/** 归一化一条消息事件 */
export function normalizeMessageEvent(ev: ObMessageEvent): InboundMessage {
  const selfId = Number(ev.self_id) || 0;
  const segments = toSegments(ev.message);
  const rawText = typeof ev.message === 'string' ? ev.message : toCqCodes(segments);
  const text = segmentsToText(segments, selfId);

  const scopeType: 'private' | 'group' = ev.message_type === 'private' ? 'private' : 'group';
  const groupId = scopeType === 'group' ? Number(ev.group_id) : undefined;
  const scope = scopeType === 'group' ? `group:${groupId}` : `private:${ev.user_id}`;

  const senderName =
    (scopeType === 'group' ? ev.sender?.card?.trim() : '') ||
    ev.sender?.nickname?.trim() ||
    String(ev.user_id);

  const msg: InboundMessage = {
    scope,
    scopeType,
    userId: Number(ev.user_id),
    messageId: Number(ev.message_id),
    selfId,
    text,
    segments,
    mentionsBot: detectMention(segments, selfId, rawText),
    senderName,
    timestamp: Number(ev.time) * 1000 || Date.now(),
    raw: ev,
  };
  if (groupId !== undefined && Number.isFinite(groupId)) msg.groupId = groupId;
  if (ev.sender?.role) msg.role = ev.sender.role;
  return msg;
}
