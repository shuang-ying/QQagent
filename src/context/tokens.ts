import type { ChatMessage, ContentPart } from '../core/types.js';
import { estimateTokens } from '../memory/store.js';
/** 保守输入估算，协议角色/消息封装与视觉额度统一计数。 */
export function imageTokens(image: ContentPart & { type: 'image' }): number {
  if (!image.width || !image.height) return 4096;
  return Math.max(1024, 85 + 170 * Math.ceil(image.width / 512) * Math.ceil(image.height / 512));
}
export function messageTokens(message: ChatMessage): number {
  return 4 + (message.name ? estimateTokens(message.name) : 0) + (typeof message.content === 'string'
    ? estimateTokens(message.content) : message.content.reduce((sum, part) => sum +
      (part.type === 'image' ? imageTokens(part) : estimateTokens(part.text)), 0));
}
export function inputTokens(messages: ChatMessage[]): number { return 16 + messages.reduce((sum, message) => sum + messageTokens(message), 0); }
