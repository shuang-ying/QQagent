import type {MemoryStore, MessageRow} from '../memory/store.js';
import type {TurnContext} from './turn.js';

export interface ReplyWindow {
  afterId: number;
  cutoffId: number;
  rows: MessageRow[];
  total: number;
}

/** Preserve stable relationship IDs; display names alone cannot disambiguate a group. */
export function messageLinks(segments: unknown): {atQQ: string[]; replyToMessageIds: number[]} {
  const atQQ: string[] = [], replyToMessageIds: number[] = [];
  if (!Array.isArray(segments)) return {atQQ, replyToMessageIds};
  for (const segment of segments.slice(0,128)) {
    if (segment?.type === 'at') {
      const qq = String(segment.data?.qq ?? '');
      if (/^(?:[0-9]+|all)$/.test(qq)) atQQ.push(qq);
    } else if (segment?.type === 'reply') {
      const id = Number(segment.data?.id);
      if (Number.isSafeInteger(id) && id !== 0) replyToMessageIds.push(id);
    }
  }
  return {atQQ: [...new Set(atQQ)].slice(0,8), replyToMessageIds: [...new Set(replyToMessageIds)].slice(0,8)};
}

/** Freeze at execution, in arrival-ID order, independently of recentTurns/summary state. */
export function captureReplyWindow(store: MemoryStore, turn: TurnContext): ReplyWindow {
  const cutoffId = Number((store.db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id=?')
    .get(turn.conversationId) as {id: number | null}).id ?? 0);
  const afterId = Number((store.db.prepare("SELECT MAX(id) AS id FROM messages WHERE conversation_id=? AND role='assistant' AND id<=?")
    .get(turn.conversationId, cutoffId) as {id: number | null}).id ?? 0);
  const total = Number((store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND id>? AND id<=?')
    .get(turn.conversationId, afterId, cutoffId) as {n: number}).n);
  const rows = (store.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND id>? AND id<=? ORDER BY id DESC LIMIT 2000')
    .all(turn.conversationId, afterId, cutoffId) as unknown as MessageRow[]).reverse();
  turn.historyCutoffId = cutoffId;
  turn.replyWindow = {afterId, cutoffId, rows, total};
  return turn.replyWindow;
}
