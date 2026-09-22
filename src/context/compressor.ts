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
import { contentToText } from '../core/types.js';
import type { MemoryStore, MessageRow, SummaryRow } from '../memory/store.js';
import { estimateTokens } from '../memory/store.js';
import type { ProviderManager } from '../llm/manager.js';

export interface BuildContextParams {
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

/**
 * 单张图片的 token 估算。
 *
 * DeepSeek 官方文档《图像理解》给出的上限是**每张图最多 1024 token**
 * （图片会被缩放，2000×2000 与 5000×5000 消耗相同）。
 * 这里按 1024 估算 —— 对 DeepSeek 是精确值，对其他厂商是偏保守的估计，
 * 宁可少放一点历史，也不要因为图片导致请求超限被拒。
 */
export const IMAGE_TOKEN_ESTIMATE = 1024;

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
  constructor(
    private readonly cfg: AppConfig['context'],
    private readonly memCfg: AppConfig['memory'],
    private readonly store: MemoryStore,
    private readonly log: Logger,
  ) {}

  /** 计算某模型的 token 预算 */
  budget(contextWindow: number): number {
    const usable = Math.min(contextWindow, this.cfg.modelContextWindow || contextWindow);
    return Math.max(512, Math.floor(usable * this.cfg.maxTokensRatio) - this.cfg.reserveForReply);
  }

  /**
   * 构建送给模型的完整消息列表
   */
  build(params: BuildContextParams): BuildContextResult {
    const budget = this.budget(params.contextWindow);
    const systemTokens = estimateTokens(params.systemPrompt);
    const userTokens = estimateTokens(params.userMessage);
    const ambientTokens = params.ambientContext ? estimateTokens(params.ambientContext) : 0;

    // ---- 人格预设对话（few-shot）----
    // 用预算换人格稳定性：示例也计入 token 开销，太贵就自动截断条数。
    const exampleMsgs: ChatMessage[] = [];
    if (params.personaExamples && params.personaExamples.length > 0) {
      const maxExamples = 4; // 最多 4 轮，避免示例把上下文挤满
      for (const ex of params.personaExamples.slice(0, maxExamples)) {
        if (!ex?.user || !ex?.assistant) continue;
        exampleMsgs.push({ role: 'user', content: ex.user });
        exampleMsgs.push({ role: 'assistant', content: ex.assistant });
      }
    }
    const exampleTokens = exampleMsgs.reduce((a, m) => a + estimateTokens(contentToText(m.content)), 0);

    // 留给历史的额度（示例与图片优先于历史：宁可少放历史也要保住风格与图片）
    const imageTokens = (params.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
    let historyBudget = budget - systemTokens - userTokens - ambientTokens - exampleTokens - imageTokens;

    const messages: ChatMessage[] = [{ role: 'system', content: params.systemPrompt }];

    // 群聊环境上下文（其他人最近说的话）作为一条 system 补充
    if (params.ambientContext) {
      messages.push({ role: 'system', content: params.ambientContext });
    }

    // 预设对话紧跟 system，作为最早的真实轮次
    messages.push(...exampleMsgs);

    // ---- 历史消息 ----
    // 多取一些候选，再按预算从新到旧纳入
    const recentLimit = Math.max(this.memCfg.recentTurns * 2, 30);
    const candidates = this.store
      .getRecentMessages(params.scope, recentLimit)
      .filter((m) => !(m.role === 'user' && m.content === params.userMessage && m.id === this.lastUserMsgId(params.scope)));

    const included: MessageRow[] = [];
    let used = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const m = candidates[i]!;
      const t = m.tokens || estimateTokens(m.content);
      if (used + t > historyBudget) break;
      included.unshift(m);
      used += t;
    }

    const trimmed = candidates.length - included.length;

    // 历史消息合并进 messages。
    // 注意：群聊里其他人的发言，role 仍然是 user，但加上名字前缀便于模型区分。
    let prevRole: string | null = null;
    for (const m of included) {
      const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
      let content = m.content;
      // 群聊中由别人说的话，标注说话人以区分
      if (role === 'user' && m.user_id !== params.userId) {
        content = `[${m.sender_name || m.user_id}]: ${content}`;
      }
      // 相邻同角色消息合并，避免某些 API 报错
      const last = messages[messages.length - 1];
      if (last && last.role === role && prevRole === role) {
        // 此处 messages 里全是纯文本消息（图片在最后才挂上），取文本拼接即可
        last.content = `${contentToText(last.content)}\n${content}`;
      } else {
        messages.push({ role, content });
        prevRole = role;
      }
    }

    // 本轮用户消息兜底（若已被包含则不重复添加）
    const lastMsg = messages[messages.length - 1];
    if (!(lastMsg && lastMsg.role === 'user' && contentToText(lastMsg.content).includes(params.userMessage))) {
      messages.push({ role: 'user', content: params.userMessage });
    }

    // ---- 把图片挂到本轮用户消息上 ----
    if (params.images && params.images.length > 0) {
      const target = messages[messages.length - 1];
      if (target && target.role === 'user') {
        let text = typeof target.content === 'string' ? target.content : contentToText(target.content);

        // 有来源标注时先列一份清单，让模型知道每张图分别是谁发的、按什么顺序。
        // 不回填的话，多张历史图片全挤在最后一条消息上，模型会以为都是同一人发的。
        const notes = params.images.map((im, i) => (im.note ? `${i + 1}. ${im.note}` : '')).filter(Boolean);
        if (notes.length > 0) {
          text += `\n\n【随这条消息一起附上的图片，按顺序】\n${notes.join('\n')}`;
        }

        const parts = params.images.map((im) => {
          const part: { type: 'image'; mimeType: string; data: string } = {
            type: 'image',
            mimeType: im.mimeType,
            data: im.data,
          };
          return part;
        });
        target.content = [{ type: 'text', text }, ...parts];
      }
    }

    // 记录摘要使用情况
    const summaries = this.store.getSummaries(params.scope, undefined, 20);

    const totalTokens = messages.reduce((acc, m) => acc + estimateTokens(contentToText(m.content)), 0);

    if (trimmed > 0) {
      this.log.debug(
        { scope: params.scope, trimmed, included: included.length, budget },
        '上下文已裁剪',
      );
    }

    return {
      messages,
      stats: {
        systemTokens,
        historyTokens: used,
        ambientTokens,
        totalTokens,
        budget,
        includedMessages: included.length,
        trimmedMessages: trimmed,
        usedSummaries: summaries.length,
        compressionTriggered: trimmed > 0,
      },
    };
  }

  private lastUserMsgId(scope: string): number {
    const rows = this.store.getRecentMessages(scope, 1);
    return rows[0]?.id ?? -1;
  }

  /**
   * 是否需要压缩：未摘要消息数超过阈值
   */
  shouldCompress(scope: string): boolean {
    if (!this.memCfg.summary.enabled) return false;
    return this.store.countUnsummarized(scope) >= this.memCfg.summary.triggerMessages;
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
  ): Promise<{ ok: boolean; summarized: number; summaryId?: number; error?: string }> {
    const all = this.store.getUnsummarizedMessages(scope, 400);
    const keep = this.memCfg.summary.keepRecentTurns * 2;

    // 保留最近 keep 条不压缩
    const toCompress = all.slice(0, Math.max(0, all.length - keep));
    if (toCompress.length < 4) {
      return { ok: false, summarized: 0, error: '待压缩消息过少' };
    }

    try {
      const summaryText = await summarize(toCompress);
      if (!summaryText.trim()) {
        return { ok: false, summarized: 0, error: '摘要生成结果为空' };
      }

      const fromId = toCompress[0]!.id;
      const toId = toCompress[toCompress.length - 1]!.id;
      const summaryId = this.store.addSummary(scope, 1, summaryText.trim(), fromId, toId, toCompress.length);
      this.store.markSummarized(toCompress.map((m) => m.id));

      this.log.info(
        { scope, count: toCompress.length, summaryTokens: estimateTokens(summaryText), summaryId },
        '✅ 上下文已压缩为摘要',
      );

      // 尝试把过多的 L1 摘要进一步压成 L2
      void this.mergeSummaries(scope, summarize);

      return { ok: true, summarized: toCompress.length, summaryId };
    } catch (e) {
      this.log.warn({ scope, err: (e as Error).message }, '摘要生成失败');
      return { ok: false, summarized: 0, error: (e as Error).message };
    }
  }

  /**
   * 递归压缩：L1 摘要太多时合并为 L2，依次到 maxLevel
   */
  private async mergeSummaries(
    scope: string,
    summarize: (messages: MessageRow[]) => Promise<string>,
  ): Promise<void> {
    for (let level = 1; level < this.memCfg.summary.maxLevel; level++) {
      const count = this.store.countSummaries(scope, level);
      if (count < 8) return;

      const list = this.store.getSummaries(scope, level, 8);
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
        this.store.addSummary(scope, level + 1, merged.trim(), null, null, list.length);
        this.log.info({ scope, level: level + 1, mergedFrom: list.length }, '摘要已递归压缩到更高层级');
      } catch (e) {
        this.log.debug({ err: (e as Error).message }, '摘要递归压缩失败（非致命）');
        return;
      }
    }
  }

  /** 组装摘要文本，供 system prompt 使用 */
  buildSummaryBlock(scope: string, maxLevels = 3): string[] {
    const out: string[] = [];
    const list = this.store.getSummaries(scope, undefined, 20);
    // 高层级摘要优先（信息密度更高）
    const sorted = list.slice().sort((a, b) => b.level - a.level || a.created_at - b.created_at);
    const seenLevels = new Set<number>();
    for (const s of sorted) {
      if (out.length >= maxLevels) break;
      if (seenLevels.has(s.level)) continue;
      seenLevels.add(s.level);
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
5. 控制在 200 字以内，用短句分条，每条一行，以「- 」开头。
6. 直接输出摘要，不要任何前言或解释。`;

export function buildSummaryUserPrompt(messages: MessageRow[]): string {
  const lines = messages.map((m) => {
    const who = m.role === 'assistant' ? 'AI' : m.sender_name || String(m.user_id);
    const emo = m.emotion_label && m.emotion_label !== 'neutral' ? `（情绪:${m.emotion_label}）` : '';
    return `${who}: ${m.content}${emo}`;
  });
  return `请摘要以下对话记录：\n\n${lines.join('\n')}`;
}
