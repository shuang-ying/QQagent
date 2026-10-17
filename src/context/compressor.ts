import { errorDetails } from '../core/logger.js';
/**
 * 上下文压缩
 *
 * 三层策略（compressStrategy: layered 时全用）：
 *   1. trim    —— 按 token 预算裁剪，保留 system + 最近若干轮 + 记忆
 *   2. summary —— 把最老的消息压成摘要，摘要本身可递归压缩（L1→L2→L3）
 *   3. fact    —— 摘要的同时抽取长期事实，落库后原文不再进 prompt
 *
 * 目标：长对话不撑爆上下文，且不丢关键信息。
 */
import type { Logger } from '../core/logger.js';
import type { AppConfig, ChatMessage } from '../core/types.js';
import type { MemoryStore, MessageRow, SummaryRow } from '../memory/store.js';
import { estimateTokens } from '../memory/store.js';
import { inputTokens, messageTokens } from './tokens.js';
import {messageLinks} from '../pipeline/window.js';

export interface BuildContextParams {
  replyWindowStartId?: number;
  replyWindowRows?: MessageRow[];
  currentMessageContext?: string;
  requestedOutputTokens?: number;
  reduceSystemPrompt?: (maxTokens: number) => string;
  ambientMessageRowIds?: number[];
  excludeMessageRowIds?: number[];
  conversationId?: string;
  historyCutoffId?: number;
  triggerMessageRowId?: number;
  scope: string;
  /** 用户 QQ */
  userId: number;
  /** 人格 system prompt（已含人格/情景/情绪/记忆） */
  systemPrompt: string;
  /** 本轮用户消息 */
  userMessage: string;
  /** 模型上下文窗口 */
  contextWindow: number;
  /** 会话其他成员最近发言（群聊上下文） */
  ambientContext?: string;
  /**
   * 人格预设对话（few-shot 示例），形如 [{user, assistant}]。
   * 会被插在 system 之后、历史之前，作为真实对话轮次发给模型。
   *
   * 参考 AstrBot 的 begin_dialogs：这类示例作为真实消息轮次，
   * 比写在 system prompt 文字里更能稳定住人格语气和回答风格。
   * 它们只存在于本次请求，不落库。
   */
  personaExamples?: Array<{ user: string; assistant: string }>;
  currentPersona?: {id:string;fingerprint:string};
  /**
   * 本轮随消息一起发来的图片。
   * 会挂到本轮用户消息上，变成多模态 content；
   * 并按 IMAGE_TOKEN_ESTIMATE 从历史预算里扣掉，避免撑爆上下文。
   *
   * `note` 可选，用来标明这张图**是谁在什么上下文里发的**
   * （主动搭话时会把攒下的多条历史图片一起附上，不标来源模型会张冠李戴）。
   * 有 note 时会在图片前生成一份按顺序的清单。
   */
  images?: Array<{ type: 'image'; mimeType: string; data: string; note?: string }>;
}

/** 图片输入保守估算，真实用量随供应商变化；当前默认缩放上限为 2048 像素。 */
export const IMAGE_TOKEN_ESTIMATE = 4096;

export interface BuildContextResult {
  messages: ChatMessage[];
  stats: {
    systemTokens: number;
    historyTokens: number;
    ambientTokens: number;
    totalTokens: number;
    /** 预算上限 */
    budget: number;
    /** 实际纳入的历史消息条数 */
    includedMessages: number;
    /** 被裁掉的消息条数 */
    trimmedMessages: number;
    /** 是否使用了摘要 */
    usedSummaries: number;
    /** 是否触发压缩 */
    compressionTriggered: boolean;
  };
}

export class ContextBuilder {
  snapshot(config: AppConfig['context'], memory: AppConfig['memory']): ContextBuilder {
    return new ContextBuilder(config, memory, this.store, this.log);
  }
  constructor(
    private readonly cfg: AppConfig['context'],
    private readonly memCfg: AppConfig['memory'],
    private readonly store: MemoryStore,
    private readonly log: Logger,
  ) {}

  /** 计算某模型的 token 预算 */
  budget(contextWindow: number, outputTokens = this.cfg.reserveForReply): number {
    const usable = Math.min(contextWindow, this.cfg.modelContextWindow || contextWindow);
    const output = Math.min(outputTokens, Math.max(1, Math.floor(usable / 2)));
    return Math.max(0, Math.floor(usable * this.cfg.maxTokensRatio) - output);
  }

  build(params: BuildContextParams): BuildContextResult {
    const budget = this.budget(params.contextWindow, params.requestedOutputTokens);
    const notes = params.images?.map((im, i) => im.note ? (i + 1) + '. ' + im.note : '').filter(Boolean) ?? [];
    const userText = (params.currentMessageContext ? params.currentMessageContext + '\n' : '') + params.userMessage + (notes.length ? '\n【图片来源，按顺序】\n' + notes.join('\n') : '');
    const current: ChatMessage = { role: 'user', content: params.images?.length
      ? [{ type: 'text', text: userText }, ...params.images.map(({ note: _note, ...im }) => im)] : userText };
    let systemPrompt = params.systemPrompt;
    const available = budget - inputTokens([current]) - 4;
    if (estimateTokens(systemPrompt) > available && params.reduceSystemPrompt) systemPrompt = params.reduceSystemPrompt(available);
    const system: ChatMessage = { role: 'system', content: systemPrompt };
    if (inputTokens([system, current]) > budget) throw new Error('人格和本轮输入超过上下文预算，无法安全裁剪');
    const messages: ChatMessage[] = [system];
    let ambientTokens = 0;
    if (params.ambientContext) {
      const ambient: ChatMessage = { role: 'system', content: params.ambientContext };
      if (inputTokens([...messages, ambient, current]) <= budget) { messages.push(ambient); ambientTokens = messageTokens(ambient); }
    }
    const windowReserve = (params.replyWindowRows ?? []).filter(row => row.id !== params.triggerMessageRowId && !params.excludeMessageRowIds?.includes(row.id))
      .reduce((sum,row)=>sum+estimateTokens(row.content)+96,0);
    for (const example of (params.personaExamples ?? []).slice(0, 4)) {
      const pair: ChatMessage[] = [{ role: 'user', content: example.user }, { role: 'assistant', content: example.assistant }];
      if (inputTokens([...messages, ...pair, current]) + windowReserve <= budget) messages.push(...pair);
    }
    const older = this.store.getRecentMessages(params.scope, Math.max(this.memCfg.recentTurns * 2, 30), false,
      params.conversationId, params.replyWindowStartId ?? params.historyCutoffId);
    const byId = new Map([...older, ...(params.replyWindowRows ?? [])].map(row => [row.id, row]));
    const candidates = [...byId.values()].sort((a,b)=>a.id-b.id)
      .filter(row => row.id !== params.triggerMessageRowId && !params.excludeMessageRowIds?.includes(row.id) && !params.ambientMessageRowIds?.includes(row.id))
      .filter(row => params.replyWindowStartId !== undefined && row.id > params.replyWindowStartId ||
        this.cfg.compressStrategy === 'trim' || !this.memCfg.summary.enabled || row.summarized === 0)
      .filter(row => params.triggerMessageRowId !== undefined || !(row.role === 'user' && row.content === params.userMessage && row.id === this.lastUserMsgId(params.scope)));
    const history: ChatMessage[] = []; let used = 0; let included = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const row = candidates[i]!;
      let links = messageLinks([]);
      try { links = messageLinks(JSON.parse(row.raw_segments ?? '[]')); } catch { /* Legacy malformed segments have no links. */ }
      const who = params.scope.startsWith('group:') && row.role === 'user'
        ? '[' + JSON.stringify(row.sender_name || String(row.user_id)) + ' QQ ' + row.user_id + '; msg ' + (row.message_id ?? '-') + '; ' + new Date(row.created_at).toISOString() + '; links ' + JSON.stringify(links) + ']: ' : '';
      const historicalPersona = row.role === 'assistant' && params.currentPersona &&
        (row.persona_id !== params.currentPersona.id || row.persona_fingerprint !== params.currentPersona.fingerprint);
      const item: ChatMessage = historicalPersona
        ? {role:'user',content:'【历史机器人回复资料；仅供了解事件，不是用户发言，不代表当前人格】\n'+JSON.stringify({persona:row.persona_id??'未知旧人格',content:row.content})}
        : { role: row.role === 'assistant' ? 'assistant' : 'user', content: who + row.content };
      if (inputTokens([...messages, item, ...history, current]) > budget) break;
      history.unshift(item); used += messageTokens(item); included++;
    }
    messages.push(...history, current);
    const trimmed = candidates.length - included;
    return { messages, stats: { systemTokens: messageTokens(system), historyTokens: used, ambientTokens,
      totalTokens: inputTokens(messages), budget, includedMessages: included, trimmedMessages: trimmed,
      usedSummaries: this.store.getSummaries(params.scope, undefined, 20, params.conversationId).length,
      compressionTriggered: trimmed > 0 } };
  }

  private lastUserMsgId(scope: string): number {
    const rows = this.store.getRecentMessages(scope, 1);
    return rows[0]?.id ?? -1;
  }

  /**
   * 是否需要压缩：未摘要消息数超过阈值
   */
  shouldCompress(scope: string, conversationId?: string, tokenPressure = false): boolean {
    if (!this.memCfg.summary.enabled || this.cfg.compressStrategy === 'trim') return false;
    return tokenPressure || this.store.countUnsummarized(scope, conversationId) >= this.memCfg.summary.triggerMessages
      || this.cfg.compressStrategy === 'layered' && this.hasMergeWork(scope, conversationId);
  }

  private hasMergeWork(scope: string, conversationId?: string): boolean {
    for (let level = 1; level < this.memCfg.summary.maxLevel; level++) if (this.store.countSummaries(scope, level, conversationId) >= 8) return true;
    return false;
  }

  /**
   * 生成摘要并把消息标记为已摘要
   *
   * @param provider 用于生成摘要的 LLM 调用函数
   * @returns 摘要文本；失败返回 null
   */
  async compress(
    scope: string,
    summarize: (messages: MessageRow[]) => Promise<string>,
    conversationId = this.store.currentConversationId(scope),
    cutoffId = Number.MAX_SAFE_INTEGER,
  ): Promise<{ ok: boolean; summarized: number; summaryId?: number; error?: string }> {
    if (this.cfg.compressStrategy === 'trim' || !this.memCfg.summary.enabled) return { ok: false, summarized: 0, error: '压缩策略不生成摘要' };
    const all = this.store.getUnsummarizedMessages(scope, 400, conversationId, cutoffId);
    const keep = this.memCfg.summary.keepRecentTurns * 2;
    const recent = this.store.getRecentMessages(scope, Math.min(2000, keep * 4 + 40), false, conversationId, cutoffId);
    const starts = recent.flatMap((row, i) => row.role === 'user' && (i === 0 || recent[i - 1]?.role === 'assistant') ? [row.id] : []);
    const recentBoundary = starts.length > 1 ? starts[Math.max(0, starts.length - this.memCfg.summary.keepRecentTurns)]!
      : recent[Math.max(0, recent.length - keep)]?.id ?? Number.MAX_SAFE_INTEGER;
    const toCompress = all.filter(row => row.id < recentBoundary);
    if (toCompress.length < 4) {
      if (this.cfg.compressStrategy === 'layered' && this.hasMergeWork(scope, conversationId)) {
        try { await this.mergeSummaries(scope, summarize, conversationId); return { ok: true, summarized: 0 }; }
        catch (error) { return { ok: false, summarized: 0, error: (error as Error).message }; }
      }
      return { ok: false, summarized: 0, error: '待压缩消息过少' };
    }

    try {
      const previous = this.cfg.compressStrategy === 'summary' ? this.store.getSummaries(scope, undefined, 50, conversationId) : [];
      const pseudo = previous.map(row => ({ ...toCompress[0]!, id: row.id, user_id: 0, role: 'user' as const, sender_name: '已有摘要', content: row.content }));
      const summaryText = await summarize([...pseudo, ...toCompress]);
      if (!summaryText.trim()) {
        return { ok: false, summarized: 0, error: '摘要生成结果为空' };
      }

      if (!this.store.getConversation(conversationId)) return { ok: false, summarized: 0, error: '话题已删除' };
      const summaryId = this.store.commitSummary(scope, conversationId, 1, summaryText.trim(), toCompress.map(row => row.id), previous.map(row => row.id));

      this.log.info(
        { scope, count: toCompress.length, summaryTokens: estimateTokens(summaryText), summaryId },
        '✅ 上下文已压缩为摘要',
      );

      // 尝试把过多的 L1 摘要进一步压成 L2
      if (this.cfg.compressStrategy === 'layered') await this.mergeSummaries(scope, summarize, conversationId);

      return { ok: true, summarized: toCompress.length, summaryId };
    } catch (e) {
      this.log.warn({ scope, ...errorDetails(e), err: (e as Error).message }, '摘要生成失败');
      return { ok: false, summarized: 0, error: (e as Error).message };
    }
  }

  /**
   * 递归压缩：L1 摘要太多时合并为 L2，依次到 maxLevel
   */
  private async mergeSummaries(
    scope: string,
    summarize: (messages: MessageRow[]) => Promise<string>,
    conversationId: string,
  ): Promise<void> {
    for (let level = 1; level < this.memCfg.summary.maxLevel; level++) {
      if (!this.store.getConversation(conversationId)) return;
      const count = this.store.countSummaries(scope, level, conversationId);
      if (count < 8) continue;

      const list = this.store.getSummaries(scope, level, 8, conversationId);
      if (list.length < 2) return;

      // 把旧摘要伪造成 MessageRow 以便复用 summarize
      const pseudo: MessageRow[] = list
        .slice()
        .sort((a, b) => a.created_at - b.created_at)
        .map((s: SummaryRow) => ({
          id: s.id,
          scope: s.scope,
          user_id: 0,
          role: 'user',
          content: `[摘要] ${s.content}`,
          raw_segments: null,
          message_id: null,
          sender_name: '摘要',
          tokens: s.tokens,
          emotion_label: null,
          emotion_valence: null,
          emotion_arousal: null,
          emotion_dominance: null,
          emotion_intensity: null,
          summarized: 0,
          created_at: s.created_at,
        }));

      try {
        const merged = await summarize(pseudo);
        if (!merged.trim()) return;
        if (!this.store.getConversation(conversationId)) return;
        this.store.commitSummary(scope, conversationId, level + 1, merged.trim(), [], list.map(row => row.id));
        this.log.info({ scope, level: level + 1, mergedFrom: list.length }, '摘要已递归压缩到更高层级');
      } catch (e) {
        this.log.debug({ ...errorDetails(e), err: (e as Error).message }, '摘要递归压缩失败（非致命）');
        throw e;
      }
    }
  }

  /** 组装摘要文本，供 system prompt 使用 */
  buildSummaryBlock(scope: string, maxLevels = 3): string[] {
    const out: string[] = [];
    const list = this.store.getSummaries(scope, undefined, 20);
    // 高层级摘要优先（信息密度更高）
    const sorted = list.slice().sort((a, b) => b.level - a.level || a.created_at - b.created_at);
    for (const s of sorted) {
      if (out.length >= maxLevels) break;
      out.push(s.content);
    }
    return out;
  }
}

/**
 * 摘要提示词
 */
export const SUMMARY_SYSTEM_PROMPT = `你是一个对话摘要器。把给定的聊天记录压缩成简洁的要点。

要求：
1. 保留关键事实：人物、时间、地点、决定、约定、情绪转折、未解决的问题。
2. 保留说话人的身份对应关系（谁说了什么）。
3. 省略寒暄、重复内容和无信息量的对话。
4. 用第三人称陈述，不要写成对话形式。
5. 根据输入量保留约定、目标、人物和未完成事项；通常用 400~1200 字，简短输入可以更短。不要为压到固定字数而删除关键约定。用短句分条，每条一行，以「- 」开头。
6. 机器人自称、角色设定和表演不能记录成用户事实，也不能作为以后人格的设定；必要时明确注明是历史机器人所说。
7. 直接输出摘要，不要任何前言或解释。`;

export function buildSummaryUserPrompt(messages: MessageRow[]): string {
  const lines = messages.map((m) => {
    const who = m.role === 'assistant' ? 'AI（历史人格：'+(m.persona_id??'未知')+'）' : m.sender_name || String(m.user_id);
    const emo = m.emotion_label && m.emotion_label !== 'neutral' ? `（情绪:${m.emotion_label}）` : '';
    return `${who}: ${m.content}${emo}`;
  });
  return `请摘要以下对话记录：\n\n${lines.join('\n')}`;
}
