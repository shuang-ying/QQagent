import type { InboundMessage } from '../core/types.js';
type Entry = { msg: InboundMessage; text: string; rows: number[]; conversationId: string;
  resolve: (result: Batch | null) => void; followers: ((result: Batch | null) => void)[]; timer: ReturnType<typeof setTimeout> };
export interface Batch { msg: InboundMessage; text: string; rows: number[] }
/** 连续短消息使用固定窗口，限制缓冲数量，原消息仍逐条留档。 */
export class ShortMessageBuffer {
  private entries = new Map<string, Entry>();
  push(msg: InboundMessage, text: string, row: number, conversationId: string, windowMs: number): Promise<Batch | null> {
    const existing = this.entries.get(msg.scope);
    if (existing && (existing.msg.userId !== msg.userId || existing.conversationId !== conversationId || existing.rows.length >= 8)) this.flush(msg.scope);
    if (!windowMs || text.length > 256 || this.entries.size >= 128) { this.flush(msg.scope); return Promise.resolve({ msg, text, rows: [row] }); }
    return new Promise(resolve => {
      const current = this.entries.get(msg.scope);
      if (current) {
        current.msg = { ...msg, segments: [...current.msg.segments, ...msg.segments] };
        current.text += `\n${text}`; current.rows.push(row); current.followers.push(resolve);
      } else {
        const timer = setTimeout(() => this.flush(msg.scope), windowMs);
        this.entries.set(msg.scope, { msg, text, rows: [row], conversationId, resolve, followers: [], timer });
      }
    });
  }
  flush(scope: string, cancel = false): void {
    const entry = this.entries.get(scope); if (!entry) return;
    clearTimeout(entry.timer); this.entries.delete(scope);
    entry.resolve(cancel ? null : { msg: entry.msg, text: entry.text, rows: entry.rows });
    for (const resolve of entry.followers) resolve(null);
  }
  stop(): void { for (const scope of this.entries.keys()) this.flush(scope, true); }
}
