/**
 * Provider 管理器
 *
 * 职责：
 *  - 持有所有 provider，惰性发现模型并缓存到 data/providers.cache.json
 *  - 提供统一的「按 provider+model 对话」入口
 *  - 主 provider 失败时按 fallback 链回退
 *  - 记录 token 用量统计
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import type {
  AppConfig,
  ChatMessage,
  DiscoveredModel,
  LlmResult,
  LlmRoleName,
  Protocol,
  ProviderConfig,
} from '../core/types.js';
import { resolveApiKey, PROJECT_ROOT } from '../config/loader.js';
import { discoverModels, testChat } from './discover.js';
import { inferModelMeta } from './protocol.js';
import { LlmClient, LlmError, type ChatOptions } from './client.js';
import { embedTexts, type EmbedResult } from './embedding.js';

interface CacheEntry {
  protocol: Exclude<Protocol, 'auto'>;
  models: DiscoveredModel[];
  discoveredAt: number;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export interface ResolvedModel {
  providerKey: string;
  providerName: string;
  modelId: string;
  modelName: string;
  protocol: Exclude<Protocol, 'auto'>;
  contextWindow: number;
  supportsStream: boolean;
  supportsVision: boolean;
}

export interface UsageRecord {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export class ProviderManager {
  private cache: CacheFile = { version: 1, entries: {} };
  private cachePath: string;
  private readonly client: LlmClient;
  /** 用量统计（内存累计，面板展示） */
  private usage = new Map<string, UsageRecord>();

  /** 运行时可变的 provider 列表（面板可动态增删） */
  private providers: Record<string, ProviderConfig>;

  constructor(
    providers: Record<string, ProviderConfig>,
    private readonly log: Logger,
    private readonly defaultContextWindow = 32768,
    /** 传入 llm 配置引用后，面板对「用途模型」的修改可立即生效 */
    private readonly llmCfg?: AppConfig['llm'],
  ) {
    this.providers = { ...providers };
    this.cachePath = path.join(PROJECT_ROOT, 'data', 'providers.cache.json');
    this.client = new LlmClient(log);
    this.loadCache();
  }

  // ==================== 用途（角色）解析 ====================

  /**
   * 解析某个用途实际使用的 provider / model。
   *
   * 规则：
   *  - provider 留空 -> 用 llm.defaultProvider
   *  - model 留空    -> 若 provider 就是默认 provider，则用 llm.defaultModel；
   *                     否则留空（由 resolveModel 取该 provider 的第一个模型）
   */
  resolveRole(role: LlmRoleName): { provider: string; model: string } {
    const defProvider = this.llmCfg?.defaultProvider ?? '';
    const defModel = this.llmCfg?.defaultModel ?? '';
    const r = this.llmCfg?.roles?.[role];

    const provider = (r?.provider ?? '').trim() || defProvider;
    const explicitModel = (r?.model ?? '').trim();
    const model = explicitModel || (provider === defProvider ? defModel : '');

    return { provider, model };
  }

  /** 列出所有用途的解析结果（面板用） */
  listRoles(): Array<{ role: LlmRoleName; provider: string; model: string; overridden: boolean }> {
    const names: LlmRoleName[] = ['chat', 'emotion', 'summary', 'facts', 'embedding', 'vision'];
    return names.map((role) => {
      const r = this.llmCfg?.roles?.[role];
      const resolved = this.resolveRole(role);
      return {
        role,
        provider: resolved.provider,
        model: resolved.model,
        overridden: Boolean((r?.provider ?? '').trim() || (r?.model ?? '').trim()),
      };
    });
  }

  /**
   * 「图片理解」用途的健康检查。
   * 配了非视觉模型时给出明确警告 —— 否则表现是"发了图但机器人没反应"，
   * 很难自查（这正是实际踩到的坑）。
   */
  visionHealth(): { ok: boolean; provider: string; model: string; warning?: string } {
    const r = this.resolveRole('vision');

    if (!r.provider || !r.model) {
      // 没单独配不算错：主对话模型支持视觉时也能用
      const main = this.resolveRole('chat');
      const mainVision = main.model ? inferModelMeta(main.model).supportsVision : false;
      if (mainVision) return { ok: true, provider: main.provider, model: main.model };
      return {
        ok: false,
        provider: main.provider,
        model: main.model,
        warning: '未配置「图片理解」用途，且主对话模型不支持图片 —— 机器人读不到图片内容',
      };
    }

    const meta = inferModelMeta(r.model);
    if (meta.supportsVision) return { ok: true, provider: r.provider, model: r.model };
    return {
      ok: false,
      provider: r.provider,
      model: r.model,
      warning:
        `${r.model} 不是多模态模型，无法读图。` +
        '请在下方改选一个支持视觉的模型（如 qwen-vl-max、gpt-4o、gemini、claude）',
    };
  }

  /**
   * 计算文本向量（用于语义记忆检索）。
   * 未配置 embedding 模型时返回明确错误，调用方应优雅降级。
   */
  async embed(
    texts: string[],
    opts?: { providerKey?: string; modelId?: string },
  ): Promise<EmbedResult> {
    const role = this.resolveRole('embedding');
    const providerKey = opts?.providerKey || role.provider;
    const modelId = opts?.modelId || role.model;

    if (!providerKey) {
      return { ok: false, vectors: [], error: '未配置供应商', latencyMs: 0 };
    }
    const prov = this.providers[providerKey];
    if (!prov) {
      return { ok: false, vectors: [], error: `供应商 ${providerKey} 不存在`, latencyMs: 0 };
    }
    if (!modelId) {
      return {
        ok: false,
        vectors: [],
        error: '未指定 embedding 模型（请在「模型用途」里为「向量化」选择一个模型）',
        latencyMs: 0,
      };
    }

    // protocol 为 auto 时，embedding 一律按 OpenAI 兼容处理（覆盖 99% 情况）
    const protocol: Exclude<Protocol, 'auto'> = prov.protocol === 'auto' ? 'openai' : prov.protocol;

    return embedTexts({
      baseURL: prov.baseURL,
      apiKey: resolveApiKey(prov),
      protocol,
      model: modelId,
      texts,
      headers: prov.headers,
    });
  }

  // ==================== Provider 动态管理 ====================

  /** 运行时添加/更新一个 provider（不写文件，仅更新内存） */
  addProvider(key: string, config: ProviderConfig): void {
    this.providers[key] = config;
    this.log.info({ provider: key, baseURL: config.baseURL }, '已添加/更新 provider');
  }

  /** 运行时删除一个 provider */
  removeProvider(key: string): boolean {
    if (!(key in this.providers)) return false;
    delete this.providers[key];
    delete this.cache.entries[key];
    this.saveCache();
    this.log.info({ provider: key }, '已删除 provider');
    return true;
  }

  /** 获取所有 provider key */
  providerKeys(): string[] {
    return Object.keys(this.providers);
  }

  // ==================== 缓存 ====================

  private loadCache(): void {
    try {
      if (fs.existsSync(this.cachePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as CacheFile;
        if (parsed?.version === 1 && parsed.entries) {
          this.cache = parsed;
          // 缓存里存的是**发现当时**推断出的能力标签。
          // 推断规则升级或用户改了 modelOverrides 之后，这些标签就是过期的
          // （典型症状：模型明明支持读图，却因为缓存写着 supportsVision=false 而被拒发图片）。
          // 所以每次加载都用当前规则重算一遍能力，只复用 id 列表。
          this.rehydrateCapabilities();
          this.log.debug({ providers: Object.keys(parsed.entries).length }, '已加载模型缓存');
        }
      }
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, '模型缓存损坏，将重新发现');
      this.cache = { version: 1, entries: {} };
    }
  }

  /**
   * 用当前的能力推断规则重算缓存里的模型能力。
   * 只保留 id，其余（vision / contextWindow / tags）全部重新推导，
   * 这样升级推断规则或改 modelOverrides 后无需清缓存即可生效。
   */
  private rehydrateCapabilities(): void {
    let changed = 0;
    for (const entry of Object.values(this.cache.entries)) {
      entry.models = entry.models.map((m) => {
        const meta = inferModelMeta(m.id);
        if (m.supportsVision !== meta.supportsVision) changed++;
        return {
          id: m.id,
          name: m.name || m.id,
          ...(meta.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
          supportsVision: meta.supportsVision,
          supportsTools: meta.supportsTools,
          supportsStream: meta.supportsStream,
          tags: meta.tags,
        };
      });
    }
    if (changed > 0) {
      this.log.info({ changed }, '模型能力缓存已按最新规则刷新');
      this.saveCache();
    }
  }

  private saveCache(): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf8');
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, '保存模型缓存失败');
    }
  }

  /** 清空某 provider 的缓存，强制重新发现 */
  clearCache(providerKey?: string): void {
    if (providerKey) delete this.cache.entries[providerKey];
    else this.cache.entries = {};
    this.saveCache();
  }

  // ==================== Provider 访问 ====================

  getProvider(key: string): ProviderConfig | undefined {
    return this.providers[key];
  }

  listProviders(): Array<{ key: string; config: ProviderConfig; hasKey: boolean; cached: number }> {
    return Object.entries(this.providers).map(([key, config]) => ({
      key,
      config,
      hasKey: !!resolveApiKey(config),
      cached: this.cache.entries[key]?.models.length ?? config.models.length,
    }));
  }

  /**
   * 解析 provider 的协议与实际模型列表。
   * 优先用配置里手写的 models；否则用缓存；再否则实时发现。
   */
  async ensureModels(providerKey: string, force = false): Promise<{ protocol: Exclude<Protocol, 'auto'>; models: DiscoveredModel[] }> {
    const p = this.providers[providerKey];
    if (!p) throw new Error(`Provider 不存在: ${providerKey}`);

    // 手动配置的模型优先（用户显式指定，不做网络探测）
    if (!force && p.models.length > 0) {
      return {
        protocol: p.protocol === 'auto' ? 'openai' : p.protocol,
        models: p.models.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          contextWindow: m.contextWindow,
          supportsVision: m.supportsVision,
          supportsTools: m.supportsTools,
          supportsStream: m.supportsStream ?? true,
          tags: m.tags,
        })),
      };
    }

    // 缓存
    const cached = this.cache.entries[providerKey];
    if (!force && cached && cached.models.length > 0) {
      return { protocol: cached.protocol, models: cached.models };
    }

    // 实时发现
    const apiKey = resolveApiKey(p);
    this.log.info({ provider: providerKey, baseURL: p.baseURL }, '正在自动发现模型列表...');

    const result = await discoverModels({
      baseURL: p.baseURL,
      apiKey,
      protocol: p.protocol,
      headers: p.headers,
    });

    if (!result.ok) {
      this.log.error(
        { provider: providerKey, error: result.error, attempts: result.attempts.length },
        '模型发现失败',
      );
      throw new Error(`[${providerKey}] ${result.error ?? '模型发现失败'}`);
    }

    this.log.info({ provider: providerKey, protocol: result.protocol, count: result.models.length }, '✅ 模型发现成功');
    this.cache.entries[providerKey] = { protocol: result.protocol, models: result.models, discoveredAt: Date.now() };
    this.saveCache();
    return { protocol: result.protocol, models: result.models };
  }

  /** 解析出实际要用的模型（含上下文窗口等元数据） */
  async resolveModel(providerKey: string, modelId?: string): Promise<ResolvedModel> {
    const p = this.providers[providerKey];
    if (!p) throw new Error(`Provider 不存在: ${providerKey}`);

    const { protocol, models } = await this.ensureModels(providerKey);
    const target = modelId || models[0]?.id;
    if (!target) throw new Error(`Provider [${providerKey}] 没有任何可用模型`);

    const meta = models.find((m) => m.id === target);
    return {
      providerKey,
      providerName: p.displayName || providerKey,
      modelId: target,
      modelName: meta?.name ?? target,
      protocol,
      contextWindow: meta?.contextWindow ?? this.defaultContextWindow,
      supportsStream: meta?.supportsStream ?? true,
      supportsVision: meta?.supportsVision ?? false,
    };
  }

  /** 列出所有 provider 的全部模型（供面板下拉） */
  async listAllModels(): Promise<Array<ResolvedModel & { providerDisplay: string }>> {
    const out: Array<ResolvedModel & { providerDisplay: string }> = [];
    for (const [key, p] of Object.entries(this.providers)) {
      if (!p.enabled) continue;
      try {
        const { protocol, models } = await this.ensureModels(key);
        for (const m of models) {
          out.push({
            providerKey: key,
            providerDisplay: p.displayName || key,
            providerName: p.displayName || key,
            modelId: m.id,
            modelName: m.name,
            protocol,
            contextWindow: m.contextWindow ?? this.defaultContextWindow,
            supportsStream: m.supportsStream ?? true,
            supportsVision: m.supportsVision ?? false,
          });
        }
      } catch (e) {
        this.log.warn({ provider: key, err: (e as Error).message }, '该 provider 模型列表不可用，已跳过');
      }
    }
    return out;
  }

  // ==================== 对话 ====================

  private buildChatOptions(
    providerKey: string,
    resolved: ResolvedModel,
    overrides: Partial<ChatOptions>,
  ): ChatOptions {
    const p = this.providers[providerKey]!;
    return {
      baseURL: p.baseURL,
      apiKey: resolveApiKey(p),
      model: resolved.modelId,
      protocol: resolved.protocol,
      headers: p.headers,
      ...overrides,
    };
  }

  private recordUsage(provider: string, model: string, result: LlmResult): void {
    const key = `${provider}/${model}`;
    const cur = this.usage.get(key) ?? { provider, model, promptTokens: 0, completionTokens: 0, calls: 0 };
    cur.promptTokens += result.usage.promptTokens;
    cur.completionTokens += result.usage.completionTokens;
    cur.calls += 1;
    this.usage.set(key, cur);
  }

  getUsage(): UsageRecord[] {
    return [...this.usage.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens));
  }

  /**
   * 流式对话（带 fallback 链）
   *
   * onDelta 每收到一段增量文本即回调；返回最终结果。
   */
  async streamChat(
    messages: ChatMessage[],
    providerKey: string,
    modelId: string | undefined,
    onDelta: (text: string) => void,
    overrides: Partial<ChatOptions> = {},
    fallbackKeys: string[] = [],
  ): Promise<LlmResult> {
    const chain = [providerKey, ...fallbackKeys.filter((k) => k !== providerKey)];
    let lastErr: Error | null = null;

    for (const key of chain) {
      try {
        const resolved = await this.resolveModel(key, modelId);
        const opts = this.buildChatOptions(key, resolved, { stream: true, ...overrides });

        let result: LlmResult | null = null;
        const gen = this.client.streamChat(messages, opts);
        // 只有第一个 provider 才允许把增量推给用户，避免回退时重复输出
        const isPrimary = key === chain[0];
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const step = await gen.next();
          if (step.done) {
            result = step.value;
            break;
          }
          if (isPrimary && step.value) onDelta(step.value);
        }
        if (!result) throw new LlmError('未获得结果');

        result.provider = resolved.providerName;
        result.model = resolved.modelId;
        this.recordUsage(key, resolved.modelId, result);
        return result;
      } catch (e) {
        lastErr = e as Error;
        const isLast = key === chain[chain.length - 1];
        this.log.warn(
          { provider: key, model: modelId, err: (e as Error).message, willFallback: !isLast },
          `Provider [${key}] 调用失败`,
        );
        if (isLast) break;
      }
    }
    throw lastErr ?? new LlmError('所有 provider 均调用失败');
  }

  /** 非流式对话（内部任务用），同样带 fallback */
  async chat(
    messages: ChatMessage[],
    providerKey: string,
    modelId: string | undefined,
    overrides: Partial<ChatOptions> = {},
    fallbackKeys: string[] = [],
  ): Promise<LlmResult> {
    const chain = [providerKey, ...fallbackKeys.filter((k) => k !== providerKey)];
    let lastErr: Error | null = null;

    for (const key of chain) {
      try {
        const resolved = await this.resolveModel(key, modelId);
        const opts = this.buildChatOptions(key, resolved, { stream: false, ...overrides });
        const result = await this.client.chat(messages, opts);
        result.provider = resolved.providerName;
        result.model = resolved.modelId;
        this.recordUsage(key, resolved.modelId, result);
        return result;
      } catch (e) {
        lastErr = e as Error;
        this.log.warn({ provider: key, err: (e as Error).message }, `Provider [${key}] 非流式调用失败`);
      }
    }
    throw lastErr ?? new LlmError('所有 provider 均调用失败');
  }

  /** 连通性自检（面板「测试连接」按钮） */
  async testConnection(providerKey: string, modelId?: string): Promise<{
    ok: boolean;
    discoverOk: boolean;
    chatOk: boolean;
    protocol: string;
    modelCount: number;
    reply: string;
    latencyMs: number;
    error?: string;
    attempts: Array<{ url: string; protocol: string; status: number | null; ok: boolean; note: string }>;
  }> {
    const p = this.providers[providerKey];
    if (!p) throw new Error(`Provider 不存在: ${providerKey}`);
    const apiKey = resolveApiKey(p);

    // 强制重新发现，拿到真实协议
    this.clearCache(providerKey);
    const disc = await discoverModels({
      baseURL: p.baseURL,
      apiKey,
      protocol: p.protocol,
      headers: p.headers,
    });

    if (!disc.ok) {
      return {
        ok: false,
        discoverOk: false,
        chatOk: false,
        protocol: String(p.protocol),
        modelCount: 0,
        reply: '',
        latencyMs: 0,
        error: disc.error,
        attempts: disc.attempts,
      };
    }

    this.cache.entries[providerKey] = {
      protocol: disc.protocol,
      models: disc.models,
      discoveredAt: Date.now(),
    };
    this.saveCache();

    // 挑一个模型做真实对话测试
    const target = modelId || disc.models[0]?.id || '';
    let chatRes: { ok: boolean; reply: string; error?: string; latencyMs: number } = {
      ok: false,
      reply: '',
      error: '无可用模型',
      latencyMs: 0,
    };
    if (target) {
      chatRes = await testChat(p.baseURL, apiKey, target, disc.protocol);
      if (chatRes.ok) {
        this.recordUsage(providerKey, target, {
          content: chatRes.reply,
          model: target,
          provider: providerKey,
          usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
          latencyMs: chatRes.latencyMs,
        });
      }
    }

    return {
      ok: disc.ok && chatRes.ok,
      discoverOk: disc.ok,
      chatOk: chatRes.ok,
      protocol: disc.protocol,
      modelCount: disc.models.length,
      reply: chatRes.reply,
      latencyMs: chatRes.latencyMs,
      ...(chatRes.error ? { error: chatRes.error } : {}),
      attempts: disc.attempts,
    };
  }
}
