import { TOKEN_BUDGET_PURPOSES, type AppConfig } from '../core/types.js';

/** 非零配置覆盖调用方预算（包括扩大预算重试）；0 保持旧行为。 */
export function outputTokenBudget(llm: AppConfig['llm'] | undefined, purpose: string, fallback: number): number {
  if (!(TOKEN_BUDGET_PURPOSES as readonly string[]).includes(purpose)) return fallback;
  const configured = llm?.tokenBudgets?.[purpose as keyof AppConfig['llm']['tokenBudgets']];
  return configured || fallback;
}

/** 面板展示填 0 时的规则；回复/摘要使用当前配置，避免硬编码成出厂值。 */
export function originalTokenBudgetLabel(llm: AppConfig['llm'], purpose: string): string {
  switch (purpose) {
    case 'chat': return `全局 ${llm.generation.maxTokens} tokens；人格设置了 maxTokens 时优先使用人格值`;
    case 'summary': return `${llm.generation.summaryMaxTokens} tokens（当前摘要配置）`;
    case 'vision': return '每图 500 tokens，最低 1200、最高 6000 tokens';
    case 'sticker': return '600 tokens';
    case 'emotion': return '200 tokens';
    case 'facts': return '800 tokens';
    case 'daily': return '1200 tokens';
    default: return '';
  }
}
