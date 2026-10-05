import type { ChatMessage } from '../core/types.js';
import { messageTokens } from '../context/tokens.js';
import { LlmError } from './client.js';

/** 每个实际模型重新计算预算，保留系统指令和当前输入，裁剪较旧历史。 */
export function fitModelBudget(messages: ChatMessage[], window: number, maxTokens: number) {
  const cost = messageTokens;
  const kept = messages.slice();
  const output = Math.min(maxTokens, Math.max(1, Math.floor(window / 2)));
  const inputBudget = window - output - 16;
  while (kept.reduce((n, m) => n + cost(m), 0) > inputBudget) {
    const index = kept.findIndex((m, i) => m.role !== 'system' && i !== kept.length - 1);
    if (index < 0) throw new LlmError('当前输入和系统指令超过该模型上下文预算');
    kept.splice(index, 1);
  }
  return { messages: kept, maxTokens: output };
}
