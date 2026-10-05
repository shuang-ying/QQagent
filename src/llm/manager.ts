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
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
import { inferModelMeta, findOverride } from './protocol.js';
import { fitModelBudget } from './budget.js';
import { LlmClient, LlmError, type ChatOptions } from './client.js';
import { embedTexts, type EmbedResult } from './embedding.js';

interface CacheEntry {
  fingerprint?: string;
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

/** 限制解析/发现等待时间，取消后不继续进入模型调用。 */
async function waitWithin<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LlmError('请求总时间预算已耗尽')), Math.max(1, ms));
      abort = () => reject(new LlmError('请求已取消', undefined, false, true));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

export class ProviderManager {
  private usageDb?: import('node:sqlite').DatabaseSync;
  attachUsageStore(db: import('node:sqlite').DatabaseSync): void {
    this.usageDb=db;db.exec('CREATE TABLE IF NOT EXISTS llm_calls (id INTEGER PRIMARY KEY,purpose TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,success INTEGER NOT NULL,prompt_tokens INTEGER NOT NULL,completion_tokens INTEGER NOT NULL,latency_ms INTEGER NOT NULL,retry INTEGER NOT NULL,created_at INTEGER NOT NULL)');
    for(const row of db.prepare('SELECT provider,model,SUM(prompt_tokens) AS promptTokens,SUM(completion_tokens) AS completionTokens,COUNT(*) AS calls FROM llm_calls WHERE success=1 GROUP BY provider,model').all() as unknown as UsageRecord[]) this.usage.set(row.provider+'/'+row.model,row);
  }
  private metric(provider:string,model:string,purpose:string,success:boolean,latency:number,retry=0,prompt=0,completion=0):void {
    this.usageDb?.prepare('INSERT INTO llm_calls(purpose,provider,model,success,prompt_tokens,completion_tokens,latency_ms,retry,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(purpose,provider,model,Number(success),prompt,completion,Math.round(latency),retry,Date.now());
  }
  recordSpeechCall(provider:string,model:string,purpose:'asr'|'tts',success:boolean,latency:number):void{this.metric(provider,model,purpose,success,latency);}
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
  resolveRole(role: LlmRoleName, config = this.llmCfg): { provider: string; model: string } {
    const defProvider = config?.defaultProvider ?? '';
    const defModel = config?.defaultModel ?? '';
    const r = config?.roles?.[role];

    const provider = (r?.provider ?? '').trim() || defProvider;
    const explicitModel = (r?.model ?? '').trim();
    const model = explicitModel || (role === 'asr' || role === 'tts' ? '' : provider === defProvider ? defModel : '');

    return { provider, model };
  }

  /**
   * 向量化是否**真的**可用。
   *
   * 不能只看 `resolveRole('embedding')` 有没有值：那个会继承 llm.defaultModel，
   * 而默认模型通常是主对话模型（纯文本），拿它去调 /embeddings 必然失败。
   * 所以必须要求**显式指定**过 embedding 模型。
   */
  embeddingReady(): { ok: boolean; provider: string; model: string; reason?: string } {
    const r = this.resolveRole('embedding');
    const explicitModel = (this.llmCfg?.roles?.['embedding']?.model ?? '').trim();
    if (!r.provider) {
      return { ok: false, provider: '', model: '', reason: '还没选择供应商' };
    }
    if (!explicitModel) {
      return {
        ok: false,
        provider: r.provider,
        model: r.model,
        reason: '还没为「向量化」选择具体的 embedding 模型（主对话模型是做不了向量化的）',
      };
    }
    return { ok: true, provider: r.provider, model: r.model };
  }

  /** 列出所有用途的解析结果（面板用） */
  listRoles(): Array<{ role: LlmRoleName; provider: string; model: string; overridden: boolean }> {
    const names: LlmRoleName[] = ['chat', 'emotion', 'summary', 'facts', 'embedding', 'vision', 'asr', 'tts'];
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
    const candidates = [this.resolveRole('vision'), this.resolveRole('chat')];
    for (const role of candidates) {
      const p = this.providers[role.provider];
      if (!p?.enabled) continue;
      const cached = this.cache.entries[role.provider];
      const models = p.models.length ? p.models : cached?.fingerprint === this.fingerprint(p) ? cached.models : [];
      const id = role.model || models[0]?.id || '';
      if (!id) continue;
      const meta = models.find(m => m.id === id);
      const visual = findOverride(id.toLowerCase())?.vision ?? meta?.supportsVision ?? inferModelMeta(id).supportsVision;
      if (visual) return { ok: true, provider: role.provider, model: id };
    }
    const main = candidates[1]!;
    return { ok: false, provider: main.provider, model: main.model,
      warning: '图片理解和主聊天模型均未配置可用的视觉能力，请检查人工能力设置或模型元数据' };
  }

  /**
   * 计算文本向量（用于语义记忆检索）。
   * 未配置 embedding 模型时返回明确错误，调用方应优雅降级。
   */
  async embed(
    texts: string[],
    opts?: { providerKey?: string; modelId?: string; signal?: AbortSignal; timeoutMs?: number },
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

    const result = await embedTexts({
      baseURL: prov.baseURL,
      apiKey: resolveApiKey(prov),
      protocol,
      model: modelId,
      texts,
      headers: prov.headers,
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    this.metric(providerKey,modelId,'embedding',result.ok,result.latencyMs);
    return result;
  }

  // ==================== Provider 动态管理 ====================

  /** 运行时添加/更新一个 provider（不写文件，仅更新内存） */
  addProvider(key: string, config: ProviderConfig): void {
    this.providers[key] = config;
    delete this.cache.entries[key];
    this.saveCache();
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
          // 服务元数据保留；人工覆盖在 resolveModel 时应用，配置指纹不符则丢弃。
          for (const [key, entry] of Object.entries(this.cache.entries)) {
            if (!this.providers[key] || entry.fingerprint !== this.fingerprint(this.providers[key]!)) delete this.cache.entries[key];
          }
          this.log.debug({ providers: Object.keys(parsed.entries).length }, '已加载模型缓存');
        }
      }
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, '模型缓存损坏，将重新发现');
      this.cache = { version: 1, entries: {} };
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

  private fingerprint(p: ProviderConfig): string {
    return createHash('sha256').update(JSON.stringify([p.baseURL, p.protocol, p.headers, p.apiKey, p.apiKeyEnv, p.models])).digest('hex');
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
    if (!p.enabled) throw new LlmError(`Provider 已禁用: ${providerKey}`);

    // 手动配置的模型优先（用户显式指定，不做网络探测）
    if (!force && p.models.length > 0) {
      return {
        protocol: p.protocol === 'auto' ? 'openai' : p.protocol,
        models: p.models.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          contextWindow: m.contextWindow ?? inferModelMeta(m.id).contextWindow,
          supportsVision: m.supportsVision ?? inferModelMeta(m.id).supportsVision,
          supportsTools: m.supportsTools ?? inferModelMeta(m.id).supportsTools,
          supportsStream: m.supportsStream ?? inferModelMeta(m.id).supportsStream,
          tags: m.tags,
        })),
      };
    }

    // 缓存
    const cached = this.cache.entries[providerKey];
    if (!force && cached && cached.fingerprint === this.fingerprint(p) && cached.models.length > 0) {
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
    if (this.providers[providerKey] !== p) throw new LlmError('供应商已更新，丢弃过时发现结果');
    this.cache.entries[providerKey] = { protocol: result.protocol, models: result.models, discoveredAt: Date.now(), fingerprint: this.fingerprint(p) };
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
    const override = findOverride(target.toLowerCase());
    const inferred = inferModelMeta(target);
    return {
      providerKey,
      providerName: p.displayName || providerKey,
      modelId: target,
      modelName: meta?.name ?? target,
      protocol,
      contextWindow: override?.contextWindow ?? meta?.contextWindow ?? inferred.contextWindow ?? this.defaultContextWindow,
      supportsStream: meta?.supportsStream ?? inferred.supportsStream,
      supportsVision: override?.vision ?? meta?.supportsVision ?? inferred.supportsVision ?? false,
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
      timeoutMs: this.llmCfg?.request.timeoutMs,
      maxRetries: this.llmCfg?.request.maxRetries,
      retryDelayMs: this.llmCfg?.request.retryDelayMs,
      temperature: this.llmCfg?.generation.temperature,
      maxTokens: this.llmCfg?.generation.maxTokens,
      ...overrides,
    };
  }

  private recordUsage(provider: string, model: string, result: LlmResult, purpose = 'chat', retry = 0): void {
    this.metric(provider,model,purpose,true,result.latencyMs,retry,result.usage.promptTokens,result.usage.completionTokens);
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
    messages: ChatMessage[], providerKey: string, modelId: string | undefined,
    onDelta: (text: string) => void, overrides: Partial<ChatOptions> = {}, fallbackKeys: AppConfig['llm']['fallback'] = [],
  ): Promise<LlmResult> {
    return this.invoke(messages, providerKey, modelId, overrides, fallbackKeys, onDelta);
  }

  async chat(
    messages: ChatMessage[], providerKey: string, modelId: string | undefined,
    overrides: Partial<ChatOptions> = {}, fallbackKeys: AppConfig['llm']['fallback'] = [],
  ): Promise<LlmResult> {
    return this.invoke(messages, providerKey, modelId, overrides, fallbackKeys);
  }

  private async invoke(
    messages: ChatMessage[], providerKey: string, modelId: string | undefined,
    overrides: Partial<ChatOptions>, fallbackKeys: AppConfig['llm']['fallback'], onDelta?: (text: string) => void,
  ): Promise<LlmResult> {
    const timeoutMs = overrides.timeoutMs ?? this.llmCfg?.request.timeoutMs ?? 120000;
    const deadline = Date.now() + timeoutMs;
    const signal = overrides.signal;
    let lastErr: Error = new LlmError('所有 provider 均调用失败');
    const chain = [{ provider: providerKey, model: modelId }, ...fallbackKeys.map(k =>
      typeof k === 'string' ? { provider: k, model: undefined } : { provider: k.provider, model: k.model || undefined })];
    const visited = new Set<string>();
    for (const candidate of chain) {
      const key = candidate.provider;
      const identity = `${key}/${candidate.model ?? ''}`;
      if (visited.has(identity)) continue;
      visited.add(identity);
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw new LlmError('请求已取消', undefined, false, true);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new LlmError('请求总时间预算已耗尽');
        const attemptStarted = Date.now();
        try {
          const resolved = await waitWithin(this.resolveModel(key, candidate.model), remaining, signal);
          if (Date.now() >= deadline) throw new LlmError('请求总时间预算已耗尽');
          const opts = this.buildChatOptions(key, resolved, { ...overrides, timeoutMs: Math.max(1, deadline - Date.now()) });
          if (messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image')) && !resolved.supportsVision) {
            throw new LlmError('该候选模型不支持图片');
          }
          const fitted = fitModelBudget(messages, resolved.contextWindow, opts.maxTokens ?? 1024);
          opts.maxTokens = fitted.maxTokens;
          let result: LlmResult;
          const chunks: string[] = [];
          const useStream = !!onDelta && (overrides.stream ?? this.llmCfg?.generation.stream ?? true) && resolved.supportsStream;
          if (useStream) {
            const gen = this.client.streamChat(fitted.messages, opts);
            while (true) {
              const step = await gen.next();
              if (step.done) { result = step.value; break; }
              chunks.push(step.value);
            }
          } else {
            result = await this.client.chat(fitted.messages, opts);
            chunks.push(result.content);
          }
          if (signal?.aborted) throw new LlmError('请求已取消', undefined, false, true);
          result.provider = resolved.providerName;
          result.model = resolved.modelId;
          this.recordUsage(key, resolved.modelId, result, overrides.purpose ?? 'chat', attempt);
          // 只有完整成功的一次尝试发布正文，重试/回退不泄露残片。
          if (onDelta) for (const chunk of chunks) onDelta(chunk);
          return result;
        } catch (e) {
          this.metric(key,candidate.model??'',overrides.purpose??'chat',false,Date.now()-attemptStarted,attempt);
          lastErr = e as Error;
          if (signal?.aborted || (e instanceof LlmError && e.cancelled)) throw e;
          const retries = overrides.maxRetries ?? this.llmCfg?.request.maxRetries ?? 2;
          const transient = e instanceof LlmError ? e.retriable : e instanceof TypeError;
          if (!transient || attempt >= retries) break;
          const waitMs = (overrides.retryDelayMs ?? this.llmCfg?.request.retryDelayMs ?? 800) * 2 ** attempt;
          if (Date.now() + waitMs >= deadline) throw new LlmError('请求总时间预算已耗尽');
          this.log.warn({ provider: key, attempt: attempt + 1, waitMs }, '临时错误，重试模型调用');
          try { await delay(waitMs, undefined, { signal }); }
          catch { throw new LlmError('请求已取消', undefined, false, true); }
        }
      }
    }
    throw lastErr;
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

    if (this.providers[providerKey] !== p) throw new LlmError('供应商已更新，丢弃过时连接测试结果');
    this.cache.entries[providerKey] = {
      fingerprint: this.fingerprint(p),
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
