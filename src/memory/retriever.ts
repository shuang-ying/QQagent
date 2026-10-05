/**
 * 记忆检索
 *
 * 组装送给模型的记忆内容：
 *  - 本会话相关的长期事实
 *  - 可跨会话共享的身份类事实（如"用户是程序员"）
 *  - 分层摘要
 *  - 群成员关系
 *
 * 遵守 crossScopeSharing 策略：默认只共享身份类事实，对话内容按会话隔离。
 */
import type { Logger } from '../core/logger.js';
import type { AppConfig } from '../core/types.js';
import type { FactRow, MemoryStore } from './store.js';
import type { SemanticIndex } from './semantic.js';

export interface RetrievalResult {
  /** 事实文本列表 */
  facts: string[];
  /** 摘要文本列表 */
  summaries: string[];
  /** 命中的事实行（用于更新 hit_count） */
  hitIds: number[];
  /** 检索统计，便于调试 */
  stats: {
    localFacts: number;
    sharedFacts: number;
    summaries: number;
    query: string;
    /** 语义检索额外补入的条数 */
    semanticHits?: number;
  };
}

/** 从消息中提取检索用的关键词（去停用词、取实词） */
export function extractQueryTerms(text: string): string {
  const stop = new Set([
    '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与', '就',
    '不', '也', '都', '很', '会', '要', '把', '被', '让', '给', '吗', '呢', '吧', '啊', '呀', '哦',
    '嗯', '什么', '怎么', '为什么', '哪个', '可以', '一个', '一下', '现在', '今天', '昨天', '明天',
  ]);

  // 提取中文词（2字以上）与英文/数字词
  const words: string[] = [];
  const cjkRe = /[\u4e00-\u9fff]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = cjkRe.exec(text)) !== null) {
    const w = m[0];
    // 把长串按 2 字切分，提高召回（中文无分词器时的折中）
    if (w.length <= 3) {
      if (!stop.has(w)) words.push(w);
    } else {
      for (let i = 0; i < w.length - 1; i++) {
        const gram = w.slice(i, i + 2);
        if (!stop.has(gram)) words.push(gram);
      }
    }
  }
  const latinRe = /[A-Za-z][A-Za-z0-9_.+-]{1,}/g;
  while ((m = latinRe.exec(text)) !== null) words.push(m[0]);

  // 去重并限长
  return [...new Set(words)].slice(0, 15).join(' ');
}

export class MemoryRetriever {
  snapshot(config: AppConfig['memory']): MemoryRetriever { return new MemoryRetriever(this.store, config, this.log, this.semantic); }
  constructor(
    private readonly store: MemoryStore,
    private readonly cfg: AppConfig['memory'],
    private readonly log: Logger,
    /** 语义索引（可选；配置了 embedding 模型后才真正生效） */
    private readonly semantic?: SemanticIndex,
  ) {}

  /**
   * 检索与当前消息相关的记忆（同步、纯关键词）。
   * 需要语义检索时用 retrieveMerged()。
   */
  retrieve(scope: string, userId: number, query: string, conversationId?: string): RetrievalResult {
    const queryTerms = extractQueryTerms(query);
    const limit = this.cfg.retrieval.limit;
    const mode = this.cfg.retrieval.crossScopeSharing;

    const factTexts: string[] = [];
    const hitIds: number[] = [];
    let localCount = 0;
    let sharedCount = 0;

    if (queryTerms) {
      const selected = this.store.searchFacts(userId,queryTerms,{scope,sharing:mode,shareableOnly:mode==='identity-facts',limit,halfLifeDays:this.cfg.retrieval.timeDecayHalfLifeDays});
      for (const f of selected) { factTexts.push(f.content); hitIds.push(f.id); if (f.scope===scope) localCount++; else sharedCount++; }
    }

    // 3) 无查询词时，取置信度最高的长期事实兜底
    if (factTexts.length === 0) {
      const top = this.store.getFactsByUser(userId, {
        scope,
        shareableOnly: mode === 'identity-facts',
        sharing: mode,
        limit: 8,
      });
      for (const f of top) {

        factTexts.push(f.content);
        hitIds.push(f.id);
      }
      localCount = factTexts.length;
    }

    // 4) 摘要
    const summaries = this.store
      .getSummaries(scope, undefined, 20, conversationId)
      .slice()
      .sort((a, b) => b.level - a.level || a.created_at - b.created_at)
      .slice(0, 3)
      .map((s) => s.content);

    if (hitIds.length > 0) {
      this.store.markFactsHit(hitIds);
    }

    this.log.debug(
      { scope, local: localCount, shared: sharedCount, summaries: summaries.length, query: queryTerms.slice(0, 40) },
      '记忆检索完成',
    );

    return {
      facts: dedupe(factTexts).slice(0, limit),
      summaries,
      hitIds,
      stats: { localFacts: localCount, sharedFacts: sharedCount, summaries: summaries.length, query: queryTerms },
    };
  }

  /**
   * 关键词检索 + 语义检索的合并结果。
   *
   * 语义检索是可选的：未配置 embedding 模型、或调用失败时，
   * 行为与 retrieve() 完全一致（不会报错，也不会变慢太多）。
   */
  async retrieveMerged(scope: string, userId: number, query: string, conversationId?: string, config?: AppConfig['memory']): Promise<RetrievalResult> {
    if (config) return new MemoryRetriever(this.store, config, this.log, this.semantic).retrieveMerged(scope, userId, query, conversationId);
    const base = this.retrieve(scope, userId, query, conversationId);

    if (!this.semantic || !this.cfg.retrieval.semantic) return base;
    if (!this.semantic.isConfigured()) return base;

    try {
      // 顺带把还没算向量的事实补上（有上限，best-effort）
      this.semantic.requestBackfill(userId);

      const mode = this.cfg.retrieval.crossScopeSharing;
      const limit = this.cfg.retrieval.limit;
      const hits = await this.semantic.search(userId, query, {
        scope,
        shareableOnly: mode === 'identity-facts',
        limit,
        minScore: this.cfg.retrieval.semanticMinScore,
      });

      if (hits.length === 0) return base;

      const ranks = new Map<number, { content: string; score: number }>();
      base.hitIds.forEach((id, rank) => { const row = this.store.db.prepare('SELECT content FROM memory_facts WHERE id=?').get(id) as { content: string } | undefined; if (row) ranks.set(id, { content: row.content, score: 1 / (60 + rank + 1) }); });
      hits.forEach((hit, rank) => { const existing = ranks.get(hit.id); ranks.set(hit.id, { content: hit.content, score: (existing?.score ?? 0) + 1 / (60 + rank + 1) }); });
      const selected = [...ranks].sort((a,b) => b[1].score-a[1].score || a[0]-b[0]).slice(0,limit);
      const hitIds = selected.map(([id]) => id);
      this.store.markFactsHit(hitIds.filter(id => !base.hitIds.includes(id)));
      return { ...base, facts: dedupe(selected.map(([,row]) => row.content)), hitIds, stats: { ...base.stats, semanticHits: hitIds.filter(id => !base.hitIds.includes(id)).length } };
    } catch (e) {
      this.log.debug({ err: (e as Error).message }, '语义检索失败，使用关键词结果');
      return base;
    }
  }

  /**
   * 用户档案：身份类事实的稳定汇总，用于让 AI"认识"这个人
   */
  buildUserProfile(userId: number, scope: string): string {
    const facts = this.store.getFactsByUser(userId, { scope, shareableOnly: this.cfg.retrieval.crossScopeSharing === 'identity-facts', sharing: this.cfg.retrieval.crossScopeSharing, limit: 30 });
    const byType = new Map<string, FactRow[]>();
    for (const f of facts) {
      const list = byType.get(f.fact_type) ?? [];
      list.push(f);
      byType.set(f.fact_type, list);
    }
    const order = ['identity', 'preference', 'skill', 'goal', 'relation', 'event', 'other'];
    const labels: Record<string, string> = {
      identity: '身份',
      preference: '喜好',
      skill: '技能',
      goal: '目标',
      relation: '关系',
      event: '经历',
      other: '其他',
    };
    const parts: string[] = [];
    for (const t of order) {
      const list = byType.get(t);
      if (!list?.length) continue;
      parts.push(`${labels[t] ?? t}：${list.map((f) => f.content).join('；')}`);
    }
    return parts.join('\n');
  }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
