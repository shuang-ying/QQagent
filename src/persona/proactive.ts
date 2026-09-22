/**
 * 主动发言
 *
 * 让机器人能适度参与群聊，而不是只会被动应答。
 *
 * 两条策略，各自有**独立可调的概率**：
 *
 *   ① 话题相关：大家在聊的跟机器人的记忆/人格对得上 → 用 relevanceProbability
 *   ② 每几句消息：群里每积累 everyNMessages 条就掷一次 → 用 probability
 *      （mode=hybrid 时结合：相关用高概率，不相关用基础概率）
 *
 * 另有四道与概率无关的硬闸门，概率再高也拦得住：
 *   - 免打扰时段
 *   - 两条主动发言之间的最小间隔
 *   - 距机器人上次说话的最小间隔
 *   - 每会话每小时上限
 *
 * 为什么要事件驱动而不是定时轮询：
 * 「每 N 条消息」这个条件只有在消息到达的那一刻才知道，
 * 靠每 5 分钟轮询一次根本数不准，而且最多要等 5 分钟才反应。
 */
import type { Logger } from '../core/logger.js';
import type { AppConfig } from '../core/types.js';
import type { MemoryStore } from '../memory/store.js';
import { isQuietHour } from '../persona/trigger.js';

export interface ProactiveContext {
  scope: string;
  scopeType: 'private' | 'group';
  /** 最近群聊里其他人的发言 */
  recentMessages: Array<{ senderName: string; text: string; timestamp: number }>;
  /** 机器人上一条发言的时间戳（0 表示没说过） */
  lastBotMessageAt: number;
  /** 与记忆/人格的相关度 0~1（由调用方计算） */
  relevance: number;
  /** 是否有人提到机器人名字或相关话题 */
  addressed: boolean;
  /** 距机器人上次发言，群里又积累了多少条消息 */
  messagesSinceBot: number;
}

export type ProactiveStrategy = 'relevant' | 'probability';

export type ProactiveDecision =
  | { speak: true; reason: string; strategy: ProactiveStrategy; probability: number }
  | { speak: false; reason: string };

export class ProactiveSpeaker {
  constructor(
    private readonly cfg: AppConfig['proactive'],
    private readonly store: MemoryStore,
    private readonly log: Logger,
  ) {}

  /**
   * 判断是否应该主动发言。
   *
   * 注意调用时机：应当在**每条群消息到达时**调用（而不是定时轮询），
   * 因为「每几句消息」需要精确的消息计数。
   */
  decide(ctx: ProactiveContext): ProactiveDecision {
    const c = this.cfg;
    if (!c.enabled || c.mode === 'off') {
      return { speak: false, reason: '主动发言已关闭' };
    }

    // 只对群聊主动发言；私聊本来就 always 回复
    if (ctx.scopeType === 'private') {
      return { speak: false, reason: '私聊不走主动发言' };
    }

    if (isQuietHour(c.quietHours)) {
      return { speak: false, reason: '当前处于免打扰时段' };
    }

    if (c.onlyWhenAddressed && !ctx.addressed) {
      return { speak: false, reason: '未提及机器人（onlyWhenAddressed）' };
    }

    if (ctx.recentMessages.length === 0) {
      return { speak: false, reason: '没有可参与的新消息' };
    }

    const now = Date.now();

    // ---- 硬闸门 1：距机器人上次说话（含被动回复）----
    // 它刚说完就别急着插嘴，否则看起来像在自言自语
    if (ctx.lastBotMessageAt > 0 && now - ctx.lastBotMessageAt < c.minGapAfterBotMs) {
      const wait = Math.ceil((c.minGapAfterBotMs - (now - ctx.lastBotMessageAt)) / 1000);
      return { speak: false, reason: `机器人刚说过话，还需等 ${wait}s` };
    }

    // ---- 硬闸门 2：两次主动发言之间的最小间隔 ----
    const last = this.store.getLastProactive(ctx.scope);
    if (last && now - last.created_at < c.minIntervalMs) {
      const wait = Math.ceil((c.minIntervalMs - (now - last.created_at)) / 1000);
      return { speak: false, reason: `距离上次主动发言还需等 ${wait}s` };
    }

    // ---- 硬闸门 3：每小时上限（0 = 不限制）----
    // 与 minIntervalMs / minGapAfterBotMs 保持一致：**0 一律表示不限制**。
    // （原来 0 会让 `recentCount >= 0` 恒真、变成"永远不发言"，跟另外两个的语义相反，很坑。）
    if (c.maxPerHourPerScope > 0) {
      const recentCount = this.store.countProactiveSince(ctx.scope, now - 3600_000);
      if (recentCount >= c.maxPerHourPerScope) {
        return { speak: false, reason: `已达每小时主动发言上限（${c.maxPerHourPerScope} 次）` };
      }
    }

    // ---- 策略判定 ----
    const relevant = ctx.relevance >= c.relevanceThreshold;

    // 话题相关，且策略允许走相关路线
    if (relevant && (c.mode === 'relevant' || c.mode === 'hybrid')) {
      if (Math.random() < c.relevanceProbability) {
        return {
          speak: true,
          strategy: 'relevant',
          probability: c.relevanceProbability,
          reason: `话题相关（${ctx.relevance.toFixed(2)}）且概率命中（p=${c.relevanceProbability}）`,
        };
      }
      return {
        speak: false,
        reason: `话题相关（${ctx.relevance.toFixed(2)}）但概率未命中（p=${c.relevanceProbability}）`,
      };
    }

    // mode=relevant 时不做"每几句消息"，相关度不够就直接放弃
    if (c.mode === 'relevant') {
      return {
        speak: false,
        reason: `话题相关度不足（${ctx.relevance.toFixed(2)} < ${c.relevanceThreshold}）`,
      };
    }

    // ---- 「每几句消息」策略 ----
    const n = c.everyNMessages;
    if (ctx.messagesSinceBot < n) {
      return {
        speak: false,
        reason: `距发言后仅 ${ctx.messagesSinceBot} 条消息，未到 ${n} 条`,
      };
    }

    // 只在「刚好攒够 N 的整数倍」时掷骰子。
    // 若每多一条都掷一次，实际概率会远高于配置值（掷 10 次 p=0.3 几乎必中），
    // 那样"概率可调"就失去意义了。
    if (ctx.messagesSinceBot % n !== 0) {
      return {
        speak: false,
        reason: `已积累 ${ctx.messagesSinceBot} 条，等待下一个 ${n} 条的判定点`,
      };
    }

    if (Math.random() < c.probability) {
      return {
        speak: true,
        strategy: 'probability',
        probability: c.probability,
        reason: `每 ${n} 条消息的机会点命中（${ctx.messagesSinceBot} 条，p=${c.probability}）`,
      };
    }
    return {
      speak: false,
      reason: `每 ${n} 条消息的机会点未命中（${ctx.messagesSinceBot} 条，p=${c.probability}）`,
    };
  }

  /**
   * 取出这条消息应该参与的上下文并做决定。
   *
   * 把「收集 recentMessages / 算相关度 / 取计数 / 决定」这一整套收在一个方法里，
   * 调用方（index.ts）只需要传 scope 和 targetId，避免调度逻辑散进消息处理里。
   *
   * 关于并发：本方法**全程同步**，JS 单线程模型保证它不会被打断，
   * 所以不需要额外的重入锁。而 index.ts 里的调用点在 `await pipeline.handle()`
   * 之后，微任务会在下一条 WS 消息事件之前跑完 ——
   * 也就是说每条消息对应的计数（5、6、7…）都会被逐个观察到，
   * 不会跳过 `messagesSinceBot % N === 0` 的判定点。
   */
  evaluate(scope: string, targetId: number, addressed: boolean): ProactiveDecision {
    const recent = this.store.getRecentMessages(scope, 10);
    const userMsgs = recent.filter((m) => m.role === 'user');
    if (userMsgs.length === 0) {
      return { speak: false, reason: '没有可参与的新消息' };
    }

    const lastBotMessageAt = this.store.getLastAssistantAt(scope);
    // 按 id 比较而不是时间戳：同一毫秒内的多条消息用时间戳会全被漏掉
    const messagesSinceBot = this.store.countUserMessagesSinceLastAssistant(scope);

    const userIds = [...new Set(userMsgs.map((m) => m.user_id))];
    const recentText = userMsgs.slice(-6).map((m) => m.content).join(' ');
    const relevance = this.computeRelevance(scope, userIds, recentText);

    const decision = this.decide({
      scope,
      scopeType: 'group',
      recentMessages: userMsgs.map((m) => ({
        senderName: m.sender_name,
        text: m.content,
        timestamp: m.created_at,
      })),
      lastBotMessageAt,
      relevance,
      addressed,
      messagesSinceBot,
    });

    if (!decision.speak) {
      this.log.debug({ scope, targetId, messagesSinceBot, relevance: Number(relevance.toFixed(2)), reason: decision.reason }, '不主动发言');
    }
    return decision;
  }

  /** 记录一次主动发言 */
  record(scope: string, reason: string, content: string): void {
    this.store.logProactive(scope, reason, content);
    this.log.info({ scope, reason, preview: content.slice(0, 40) }, '💬 主动发言');
  }

  /**
   * 计算话题与记忆/人格的相关度
   *
   * 简化实现：用用户长期事实的关键词与群聊内容做重合度计算。
   * 相关度高说明"大家在聊机器人知道/关心的事"，适合插话。
   */
  computeRelevance(scope: string, userIds: number[], recentText: string): number {
    if (!recentText.trim()) return 0;

    // 收集这些用户的长期记忆关键词
    const keywords = new Set<string>();
    for (const uid of userIds.slice(0, 10)) {
      const facts = this.store.getFactsByUser(uid, { scope, shareableOnly: true, limit: 20 });
      for (const f of facts) {
        for (const k of f.keywords.split(/\s+/)) {
          if (k.length >= 2) keywords.add(k.toLowerCase());
        }
      }
    }
    if (keywords.size === 0) return 0;

    const text = recentText.toLowerCase();
    let hit = 0;
    for (const k of keywords) {
      if (text.includes(k)) hit++;
    }
    // 命中比例，并做归一化（命中 3 个以上算高分）
    return Math.min(1, hit / Math.max(3, Math.min(keywords.size, 10)));
  }
}
