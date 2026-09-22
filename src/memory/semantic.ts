/**
 * 语义记忆索引
 *
 * 用「模型用途 → 向量化」配置的 embedding 模型，为长期事实建立向量索引，
 * 从而支持按语义（而不只是关键词）召回记忆。
 *
 * 设计原则：
 *  - 完全可选：未配置 embedding 模型时所有方法安全返回空，检索退回 FTS
 *  - best-effort：向量化失败只记 debug 日志，绝不影响主对话流程
 *  - 按需补算：新事实在后续检索时被逐步补上向量，不需要改动写入路径
 */
import type { Logger } from '../core/logger.js';
import type { ProviderManager } from '../llm/manager.js';
import type { FactRow, MemoryStore } from './store.js';

export class SemanticIndex {
  constructor(
    private readonly store: MemoryStore,
    private readonly providers: ProviderManager,
    private readonly log: Logger,
  ) {}

  /** 当前生效的 embedding 模型标识（provider/model） */
  private currentModel(): { provider: string; model: string; key: string } {
    const r = this.providers.resolveRole('embedding');
    return { provider: r.provider, model: r.model, key: `${r.provider}::${r.model}` };
  }

  /** 是否已配置 embedding 模型 */
  isConfigured(): boolean {
    const { provider, model } = this.currentModel();
    return Boolean(provider && model);
  }

  /** 向量化文本；失败返回 null（调用方应降级） */
  async embed(texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    try {
      const res = await this.providers.embed(texts);
      if (!res.ok) {
        this.log.debug({ err: res.error }, '向量化失败，本次退回关键词检索');
        return null;
      }
      return res.vectors;
    } catch (e) {
      this.log.debug({ err: (e as Error).message }, '向量化异常，本次退回关键词检索');
      return null;
    }
  }

  /**
   * 为缺少向量的事实补算（按需调用，每次有上限，避免拖慢响应）。
   * @returns 本次补算的条数
   */
  async backfill(userId: number, limit = 30): Promise<number> {
    if (!this.isConfigured()) return 0;

    const { key } = this.currentModel();
    let missing: FactRow[];
    try {
      missing = this.store.listFactsMissingEmbedding(userId, key, limit);
    } catch (e) {
      this.log.debug({ err: (e as Error).message }, '查询待补算事实失败');
      return 0;
    }
    if (missing.length === 0) return 0;

    const vectors = await this.embed(missing.map((f) => f.content));
    if (!vectors) return 0;

    let n = 0;
    for (let i = 0; i < missing.length; i++) {
      const vec = vectors[i];
      const fact = missing[i];
      if (!vec || !fact) continue;
      try {
        this.store.saveFactEmbedding(fact.id, vec, key);
        n++;
      } catch (e) {
        this.log.debug({ err: (e as Error).message, factId: fact.id }, '保存向量失败');
      }
    }
    if (n > 0) this.log.debug({ userId, count: n }, '已补算事实向量');
    return n;
  }

  /**
   * 语义检索事实。
   * @returns 命中列表；未配置或失败时返回空数组
   */
  async search(
    userId: number,
    query: string,
    opts: { scope?: string; shareableOnly?: boolean; limit?: number; minScore?: number },
  ): Promise<Array<FactRow & { score: number; similarity: number }>> {
    if (!this.isConfigured() || !query.trim()) return [];

    const vectors = await this.embed([query]);
    const qv = vectors?.[0];
    if (!qv) return [];

    const { key } = this.currentModel();
    try {
      return this.store.searchFactsByVector(userId, qv, { ...opts, model: key });
    } catch (e) {
      this.log.debug({ err: (e as Error).message }, '向量检索失败');
      return [];
    }
  }

  /** 是否已经为该用户建立过任何向量索引 */
  hasIndex(userId: number): boolean {
    const { key } = this.currentModel();
    try {
      return this.store.countFactsMissingEmbedding(userId, key) === 0;
    } catch {
      return false;
    }
  }
}
