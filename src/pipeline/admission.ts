import type { InboundMessage } from '../core/types.js';
import type { TriggerPolicy } from '../persona/trigger.js';

export class EventDeduper {
  private seen = new Map<string, number>();
  constructor(private readonly capacity = 4096, private readonly ttlMs = 600000) {}
  accept(key: string, now = Date.now()): boolean {
    for (const [id, time] of this.seen) { if (now - time >= this.ttlMs) this.seen.delete(id); else break; }
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    while (this.seen.size > this.capacity) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
  get size() { return this.seen.size; }
}
/** 命令、聊天共用准入；无可靠 ID 的消息不猜测是否重复。 */
export class InboundAdmission {
  private deduper = new EventDeduper();
  constructor(private readonly trigger: TriggerPolicy) {}
  admit(msg: InboundMessage, command = false): { allowed: boolean; reason?: string } {
    const gate = this.trigger.checkMessage(msg, command);
    if (!gate.allowed) return gate;
    if (msg.messageId && !this.deduper.accept(`${msg.selfId}/${msg.scope}/${msg.messageId}`)) return { allowed: false, reason: '重复事件' };
    return { allowed: true };
  }
}
