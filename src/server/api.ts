/**
 * 管理面板服务端
 *
 * 提供 REST API + 内嵌单页前端：
 *  - 概览：运行状态、统计
 *  - Provider：填 URL+Key → 自动探测模型；测试连接；设为默认
 *  - 人格：查看/编辑/切换
 *  - 记忆：按 QQ 查看用户、事实、消息、情绪曲线
 *  - 用量：token 统计
 */
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Logger } from '../core/logger.js';
import type { AppConfig, LlmRoleName, Persona, ProviderConfig } from '../core/types.js';
import { LLM_ROLE_LABELS, LLM_ROLE_NAMES } from '../core/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { ProviderManager } from '../llm/manager.js';
import type { PersonaManager } from '../persona/manager.js';
import { discoverModels } from '../llm/discover.js';
import { resolveApiKey, normalizeBaseUrl, PROJECT_ROOT } from '../config/loader.js';
import {
  SETTING_DEFS,
  readPath,
  validatePersona,
  readAccess,
  validateAccess,
  ACCESS_LIST_PATHS,
  ACCESS_LIST_LABELS,
  ACCESS_FLAG_PATHS,
  ACCESS_FLAG_LABELS,
  type AccessListName,
  type AccessFlagName,
} from '../config/settings.js';
import { EMOTION_LABELS_CN } from '../emotion/analyzer.js';
import { FACT_TYPE_CN } from '../memory/extractor.js';
import { getPanelHtml } from '../web/panel.js';
import { StickerLibrary } from '../persona/stickers.js';
import { safeRelPath } from '../persona/stickerAnalyze.js';
import { sniffMime } from '../llm/vision.js';
import type { ImportResult } from '../persona/stickerImport.js';
import type { AnalyzeResult } from '../persona/stickerAnalyze.js';

export interface ServerDeps {
  cfg: AppConfig;
  store: MemoryStore;
  providers: ProviderManager;
  personas: PersonaManager;
  log: Logger;
  /** 运行时状态查询（连接状态、机器人账号等） */
  runtime: () => {
    napcatConnected: boolean;
    selfId: number;
    nickname: string;
    uptimeMs: number;
    startedAt: number;
  };
  /** 更新默认 provider + 模型（写回配置文件并热生效） */
  updateDefaultModel: (providerKey: string, modelId: string) => void;
  /** 保存/新增一个供应商（写回 providers.local.yaml 并更新运行时） */
  saveProvider: (key: string, config: ProviderConfig) => void;
  /** 删除一个供应商 */
  deleteProvider: (key: string) => void;
  /** 重新从磁盘加载人格文件 */
  reloadPersonas: () => number;
  /** 切换默认人格（写回 app.yaml + 热生效） */
  setDefaultPersona: (personaId: string) => void;
  /** 新增或更新一个人格文件 */
  savePersona: (persona: Persona, isNew: boolean) => void;
  /** 删除一个人格文件 */
  deletePersona: (id: string) => void;
  /** 批量更新设置（功能开关 / 模型用途）。
   * patch 的 key 是点分路径，如 { 'emotion.enabled': false }。
   * @returns 实际发生变化的条目数
   */
  updateSettings: (patch: Record<string, unknown>) => number;
  /** 应用访问控制改动（已校验的 [路径, 值] 条目） */
  updateAccess: (entries: Array<[string[], unknown]>) => number;
  /** 测试 embedding 是否可用 */
  testEmbedding: (
    providerKey: string,
    model: string,
  ) => Promise<{ ok: boolean; dim: number; latencyMs: number; error?: string }>;
  /** 向量索引统计 */
  embeddingStats: () => { total: number; models: Array<{ model: string; count: number }> };
  /** 当前各模块实际生效的配置 */
  runtimeDetail: () => {
    emotion: { mode: string; providerKey: string; modelId: string };
    facts: { providerKey: string; modelId: string };
    roles: Array<{ role: LlmRoleName; provider: string; model: string; overridden: boolean }>;
    semanticReady: boolean;
    vision: { ok: boolean; provider: string; model: string; warning?: string };
  };
  /** 实时表情包库（未启用时为 null） */
  stickers?: () => StickerLibrary | null;
  /** 重新加载表情包目录 */
  reloadStickers?: () => number | Promise<number>;
  /** 从 QQ 收藏导入表情包 */
  importQqStickers?: (limit: number) => Promise<ImportResult>;
  /** 用视觉模型识别表情包含义 */
  analyzeStickers?: (opts: {
    force?: boolean;
    limit?: number;
    files?: string[];
  }) => Promise<AnalyzeResult>;
  /** 把 AI 描述回写到 QQ 收藏表情 */
  pushStickerDesc?: () => Promise<{ ok: number; failed: number }>;
}

export function createServer(deps: ServerDeps): { app: Hono; start: () => void; stop: () => void } {
  const { cfg, store, providers, personas, log, runtime } = deps;
  const app = new Hono();

  // ==================== 鉴权 ====================
  // authToken 为空且只监听回环地址时视为本机可信任
  const requireAuth = cfg.server.authToken.length > 0;
  app.use('/api/*', async (c, next) => {
    if (!requireAuth) return next();
    const token =
      c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ??
      c.req.header('x-auth-token') ??
      c.req.query('token');
    if (token !== cfg.server.authToken) {
      return c.json({ ok: false, error: '未授权：token 不正确' }, 401);
    }
    return next();
  });

  // ==================== 概览 ====================
  app.get('/api/overview', (c) => {
    const rt = runtime();
    const stats = store.stats();
    const usage = providers.getUsage();
    return c.json({
      ok: true,
      app: { name: cfg.app.name, version: '0.1.0', personaDefault: cfg.persona.default },
      llm: {
        defaultProvider: cfg.llm.defaultProvider,
        defaultModel: cfg.llm.defaultModel,
        providerCount: providers.providerKeys().length,
      },
      runtime: rt,
      stats,
      usage: {
        byModel: usage,
        totalPrompt: usage.reduce((a, u) => a + u.promptTokens, 0),
        totalCompletion: usage.reduce((a, u) => a + u.completionTokens, 0),
        totalCalls: usage.reduce((a, u) => a + u.calls, 0),
      },
      features: {
        emotion: cfg.emotion.enabled ? cfg.emotion.mode : 'off',
        factExtraction: cfg.memory.factExtraction,
        summary: cfg.memory.summary.enabled,
        proactive: cfg.proactive.enabled ? cfg.proactive.mode : 'off',
        compress: cfg.context.compressStrategy,
      },
    });
  });

  // ==================== Providers ====================
  app.get('/api/providers', (c) => {
    const list = providers.listProviders().map(({ key, config, hasKey, cached }) => ({
      key,
      displayName: config.displayName || key,
      protocol: config.protocol,
      baseURL: config.baseURL,
      hasKey,
      keyPreview: hasKey ? maskKey(resolveApiKey(config)) : '',
      enabled: config.enabled,
      modelCount: cached,
      isDefault: key === cfg.llm.defaultProvider,
    }));
    return c.json({
      ok: true,
      providers: list,
      defaultProvider: cfg.llm.defaultProvider,
      defaultModel: cfg.llm.defaultModel,
    });
  });

  /** 模型发现：核心接口——填 URL+Key 即可搜索可用模型 */
  app.post('/api/providers/discover', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      baseURL?: string;
      apiKey?: string;
      protocol?: string;
      providerKey?: string;
    };

    let baseURL = body.baseURL?.trim() ?? '';
    let apiKey = body.apiKey?.trim() ?? '';
    let protocol = (body.protocol ?? 'auto') as 'auto' | 'openai' | 'anthropic' | 'gemini' | 'ollama';

    // 允许基于已保存的 provider 直接探测（不传 Key 时从配置读取）
    if (body.providerKey) {
      const p = providers.getProvider(body.providerKey);
      if (p) {
        baseURL = baseURL || p.baseURL;
        if (!apiKey) apiKey = resolveApiKey(p);
        if (protocol === 'auto' && p.protocol !== 'auto') protocol = p.protocol;
      }
    }

    if (!baseURL) return c.json({ ok: false, error: '请填写 API 地址' }, 400);

    const result = await discoverModels({
      baseURL,
      apiKey,
      protocol,
      timeoutMs: 20000,
    });

    // 同时探测对话端点是否可用（有些中转站不提供 /models）
    return c.json({
      ok: result.ok,
      protocol: result.protocol,
      count: result.models.length,
      models: result.models,
      attempts: result.attempts,
      ...(result.error ? { error: result.error } : {}),
    });
  });

  /** 新增/保存供应商（写回 providers.local.yaml） */
  app.post('/api/providers/add', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      key?: string;
      displayName?: string;
      baseURL?: string;
      apiKey?: string;
      protocol?: string;
      enabled?: boolean;
    };

    const key = body.key?.trim();
    if (!key) return c.json({ ok: false, error: '缺少供应商标识 key' }, 400);
    if (!body.baseURL?.trim()) return c.json({ ok: false, error: '缺少 API 地址' }, 400);

    const config: ProviderConfig = {
      displayName: body.displayName?.trim() || key,
      protocol: (body.protocol as ProviderConfig['protocol']) || 'auto',
      baseURL: body.baseURL.trim(),
      apiKey: body.apiKey?.trim() || '',
      apiKeyEnv: '',
      models: [],
      discover: { mode: 'auto' },
      headers: {},
      enabled: body.enabled !== false,
    };

    try {
      deps.saveProvider(key, config);
      return c.json({ ok: true, message: `供应商 ${key} 已保存`, key });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 删除供应商 */
  app.delete('/api/providers/:key', (c) => {
    const key = c.req.param('key');
    try {
      deps.deleteProvider(key);
      // 如果删的是默认 provider，清空默认设置
      if (cfg.llm.defaultProvider === key) {
        cfg.llm.defaultProvider = '';
        cfg.llm.defaultModel = '';
      }
      return c.json({ ok: true, message: `供应商 ${key} 已删除` });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 更新已有供应商的 URL/Key */
  app.post('/api/providers/:key/update', async (c) => {
    const key = c.req.param('key');
    const body = (await c.req.json().catch(() => ({}))) as {
      displayName?: string;
      baseURL?: string;
      apiKey?: string;
      protocol?: string;
      enabled?: boolean;
    };

    const existing = providers.getProvider(key);
    if (!existing) return c.json({ ok: false, error: '供应商不存在' }, 404);

    const config: ProviderConfig = {
      displayName: body.displayName?.trim() || existing.displayName || key,
      protocol: (body.protocol as ProviderConfig['protocol']) || existing.protocol,
      baseURL: body.baseURL?.trim() || existing.baseURL,
      apiKey: body.apiKey !== undefined ? (body.apiKey.trim() || existing.apiKey) : existing.apiKey,
      apiKeyEnv: existing.apiKeyEnv,
      models: existing.models,
      discover: existing.discover,
      headers: existing.headers,
      enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
    };

    try {
      deps.saveProvider(key, config);
      // 清除缓存，让下次重新发现
      providers.clearCache(key);
      return c.json({ ok: true, message: `供应商 ${key} 已更新` });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 连通性测试 */
  app.post('/api/providers/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { providerKey?: string; model?: string };
    if (!body.providerKey) return c.json({ ok: false, error: '缺少 providerKey' }, 400);
    try {
      const r = await providers.testConnection(body.providerKey, body.model);
      return c.json(r);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 设置默认模型 */
  app.post('/api/providers/set-default', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { providerKey?: string; model?: string };
    if (!body.providerKey) return c.json({ ok: false, error: '缺少 providerKey' }, 400);
    try {
      deps.updateDefaultModel(body.providerKey, body.model ?? '');
      return c.json({ ok: true, message: `默认已设为 ${body.providerKey}${body.model ? '/' + body.model : ''}（重启后完全生效）` });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 列出某 provider 的所有模型 */
  app.get('/api/providers/:key/models', async (c) => {
    const key = c.req.param('key');
    try {
      const { protocol, models } = await providers.ensureModels(key);
      return c.json({ ok: true, protocol, models });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  // ==================== 设置：功能开关 + 模型用途 ====================
  /** 列出所有可切换的功能开关及其当前值 */
  app.get('/api/settings', (c) => {
    const settings = SETTING_DEFS.map((d) => ({
      path: d.path,
      label: d.label,
      desc: d.desc,
      type: d.type,
      group: d.group,
      ...(d.options ? { options: d.options } : {}),
      value: readPath(cfg, d.path),
    }));

    // 分组，便于前端渲染
    const groups: Record<string, typeof settings> = {};
    for (const s of settings) {
      (groups[s.group] ??= []).push(s);
    }

    return c.json({ ok: true, groups, settings });
  });

  /**
   * 更新开关 / 模型用途。
   * body: { patch: { 'emotion.enabled': false, 'llm.roles.embedding.model': 'x' } }
   */
  app.post('/api/settings', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { patch?: Record<string, unknown> };
    if (!body.patch || typeof body.patch !== 'object') {
      return c.json({ ok: false, error: '缺少 patch' }, 400);
    }
    try {
      const changed = deps.updateSettings(body.patch);
      return c.json({
        ok: true,
        changed,
        message: changed === 0 ? '没有变化' : `已更新 ${changed} 项并立即生效`,
      });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  /** 模型用途（chat / emotion / summary / facts / embedding / vision） */
  app.get('/api/llm/roles', (c) => {
    const detail = deps.runtimeDetail();
    const byRole = new Map(detail.roles.map((r) => [r.role, r]));

    const roles = LLM_ROLE_NAMES.map((role) => {
      const r = byRole.get(role);
      const override = cfg.llm.roles?.[role];
      return {
        role,
        ...LLM_ROLE_LABELS[role],
        provider: r?.provider ?? '',
        model: r?.model ?? '',
        overridden: r?.overridden ?? false,
        /** 面板编辑用的原始覆盖值 */
        overrideProvider: override?.provider ?? '',
        overrideModel: override?.model ?? '',
      };
    });

    return c.json({
      ok: true,
      roles,
      defaultProvider: cfg.llm.defaultProvider,
      defaultModel: cfg.llm.defaultModel,
      providers: providers.listProviders().map(({ key, config }) => ({
        key,
        displayName: config.displayName || key,
      })),
      semanticReady: detail.semanticReady,
      vision: detail.vision,
      embedding: deps.embeddingStats(),
      emotion: detail.emotion,
      facts: detail.facts,
    });
  });

  /** 测试某个 provider+model 能否做向量化 */
  app.post('/api/llm/roles/test-embedding', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { providerKey?: string; model?: string };
    const role = cfg.llm.roles?.embedding;
    const providerKey = body.providerKey?.trim() || role?.provider || cfg.llm.defaultProvider;
    const model = body.model?.trim() || role?.model || '';
    if (!providerKey) return c.json({ ok: false, error: '未配置供应商' }, 400);
    if (!model) return c.json({ ok: false, error: '请先为该用途选择模型' }, 400);
    try {
      const r = await deps.testEmbedding(providerKey, model);
      return c.json(r);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  // ==================== 访问控制 ====================
  /** 读取当前白名单/黑名单/管理员配置 */
  app.get('/api/access', (c) => {
    const snap = readAccess(cfg);
    return c.json({
      ok: true,
      lists: Object.entries(ACCESS_LIST_PATHS).map(([id, path]) => ({
        id,
        path,
        name: ACCESS_LIST_LABELS[id as AccessListName].name,
        desc: ACCESS_LIST_LABELS[id as AccessListName].desc,
        value: snap.lists[id as AccessListName],
      })),
      flags: Object.entries(ACCESS_FLAG_PATHS).map(([id, path]) => ({
        id,
        path,
        name: ACCESS_FLAG_LABELS[id as AccessFlagName].name,
        desc: ACCESS_FLAG_LABELS[id as AccessFlagName].desc,
        value: snap.flags[id as AccessFlagName],
      })),
      /** 提示：当前生效范围概览 */
      summary: {
        userScope:
          snap.lists.allowUsers.length > 0
            ? `仅白名单 ${snap.lists.allowUsers.length} 人`
            : '所有人（未设用户白名单）',
        groupScope:
          snap.lists.allowGroups.length > 0
            ? `仅白名单 ${snap.lists.allowGroups.length} 个群`
            : '所有群（未设群白名单）',
        denied: snap.lists.denyUsers.length,
        admins: snap.lists.admins.length,
      },
    });
  });

  /**
   * 更新访问控制。
   * body: { lists: { allowUsers: [..] | "123,456" }, flags: { commandAdminOnly: true } }
   */
  app.post('/api/access', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      lists?: Record<string, unknown>;
      flags?: Record<string, unknown>;
    };
    if (!body.lists && !body.flags) return c.json({ ok: false, error: '没有要更新的内容' }, 400);

    const result = validateAccess(cfg, { lists: body.lists ?? {}, flags: body.flags ?? {} });
    if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
    if (result.entries.length === 0) return c.json({ ok: true, changed: 0, message: '没有变化' });

    try {
      const changed = deps.updateAccess(result.entries);
      return c.json({ ok: true, changed, message: `已更新 ${changed} 项并立即生效` });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  // ==================== 人格 ====================
  app.get('/api/personas', (c) => {
    return c.json({
      ok: true,
      default: cfg.persona.default,
      // 返回**完整**人格对象，不要只给投影。
      // 面板的编辑器是"读进来 → 改 → 整个存回去"，少给一个字段，
      // 用户一保存那个字段就被抹成默认值了（examples / pokeReplies 就这样丢过）。
      personas: personas.list().map((p) => ({
        id: p.id,
        name: p.name,
        emoji: p.emoji,
        description: p.description,
        temperature: p.temperature,
        maxTokens: p.maxTokens,
        systemPrompt: p.systemPrompt,
        emotionModulation: p.emotionModulation,
        triggers: p.triggers,
        examples: p.examples,
        exampleCount: p.examples.length,
        pokeReplies: p.pokeReplies,
        errorMessage: p.errorMessage,
      })),
    });
  });

  /** 会话人格设置 */
  app.get('/api/personas/scope', (c) => {
    const sessions = store.listSessions(200).map((s) => ({
      scope: s.scope,
      scopeType: s.scope_type,
      targetId: s.target_id,
      title: s.title,
      personaId: s.persona_id,
      lastActive: s.last_active,
      messageCount: s.message_count,
    }));
    return c.json({
      ok: true,
      config: cfg.persona.scope,
      default: cfg.persona.default,
      sessions,
    });
  });

  app.post('/api/personas/scope', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scope?: string; personaId?: string };
    if (!body.scope) return c.json({ ok: false, error: '缺少 scope' }, 400);
    if (!body.personaId) return c.json({ ok: false, error: '缺少 personaId' }, 400);
    const ok = personas.setForSession(body.scope, body.personaId);
    return c.json({ ok, ...(ok ? {} : { error: '人格不存在' }) });
  });

  /** 切换默认人格 */
  app.post('/api/personas/default', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { personaId?: string };
    if (!body.personaId) return c.json({ ok: false, error: '缺少 personaId' }, 400);
    try {
      deps.setDefaultPersona(body.personaId);
      return c.json({ ok: true, message: `默认人格已切换为 ${body.personaId}` });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  /** 新增人格 */
  app.post('/api/personas/create', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const checked = validatePersona(body.persona ?? body);
    if (!checked.ok) return c.json({ ok: false, error: checked.error }, 400);
    try {
      deps.savePersona(checked.persona, true);
      return c.json({ ok: true, message: `人格「${checked.persona.name}」已创建`, id: checked.persona.id });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  /** 更新已有（或另存为）人格 */
  app.post('/api/personas/:id/update', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const src = (body.persona ?? body) as Record<string, unknown>;
    // 允许改名/改 id：以 id 参数为准定位原人格，用 body 里的内容覆盖
    const checked = validatePersona({ ...src, id: src.id ?? id });
    if (!checked.ok) return c.json({ ok: false, error: checked.error }, 400);
    try {
      deps.savePersona(checked.persona, false);
      return c.json({ ok: true, message: `人格「${checked.persona.name}」已保存` });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  /** 删除人格 */
  app.delete('/api/personas/:id', (c) => {
    const id = c.req.param('id');
    try {
      deps.deletePersona(id);
      return c.json({ ok: true, message: `人格 ${id} 已删除` });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  /** 重新加载人格文件 */
  app.post('/api/personas/reload', (c) => {
    try {
      const count = deps.reloadPersonas();
      return c.json({ ok: true, count, message: `已重新加载 ${count} 个人格` });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  // ==================== 话题（会话下的对话） ====================
  /** 列出某会话的全部话题 */
  app.get('/api/sessions/:scope/conversations', (c) => {
    const scope = decodeURIComponent(c.req.param('scope'));
    try {
      const current = store.currentConversationId(scope);
      const list = store.listConversations(scope, { includeArchived: true, limit: 100 });
      return c.json({
        ok: true,
        scope,
        currentId: current,
        conversations: list.map((x) => ({
          id: x.id,
          title: x.title,
          personaId: x.persona_id,
          tokenUsage: x.token_usage,
          archived: x.archived === 1,
          messageCount: x.message_count,
          firstSeen: x.first_seen,
          lastActive: x.last_active,
          isCurrent: x.id === current,
        })),
      });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 某话题的消息 */
  app.get('/api/conversations/:id/messages', (c) => {
    const id = c.req.param('id');
    const limit = Math.min(500, Number(c.req.query('limit') ?? 200));
    const conv = store.getConversation(id);
    if (!conv) return c.json({ ok: false, error: '话题不存在' }, 404);
    const messages = store.getConversationMessages(id, limit).map((m) => ({
      id: m.id,
      userId: m.user_id,
      role: m.role,
      content: m.content,
      senderName: m.sender_name,
      emotionLabel: m.emotion_label,
      summarized: m.summarized === 1,
      createdAt: m.created_at,
    }));
    return c.json({
      ok: true,
      conversation: {
        id: conv.id,
        scope: conv.scope,
        title: conv.title,
        personaId: conv.persona_id,
        tokenUsage: conv.token_usage,
        messageCount: conv.message_count,
      },
      messages,
    });
  });

  /** 新建话题并切换 */
  app.post('/api/conversations/new', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scope?: string; title?: string };
    if (!body.scope) return c.json({ ok: false, error: '缺少 scope' }, 400);
    try {
      const id = store.newConversation(body.scope, body.title?.trim() || '');
      return c.json({ ok: true, id, message: '已新建话题并切过去' });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 切换话题 */
  app.post('/api/conversations/:id/switch', (c) => {
    const id = c.req.param('id');
    const conv = store.getConversation(id);
    if (!conv) return c.json({ ok: false, error: '话题不存在' }, 404);
    const ok = store.switchConversation(conv.scope, id);
    return c.json({ ok, ...(ok ? { message: `已切到「${conv.title}」` } : { error: '切换失败' }) });
  });

  /** 改名 */
  app.post('/api/conversations/:id/rename', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    if (!store.getConversation(id)) return c.json({ ok: false, error: '话题不存在' }, 404);
    store.renameConversation(id, (body.title ?? '').trim().slice(0, 60));
    return c.json({ ok: true, message: '已改名' });
  });

  /** 归档 / 取消归档 */
  app.post('/api/conversations/:id/archive', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { archived?: boolean };
    if (!store.getConversation(id)) return c.json({ ok: false, error: '话题不存在' }, 404);
    store.archiveConversation(id, body.archived !== false);
    return c.json({ ok: true, message: body.archived !== false ? '已归档' : '已恢复' });
  });

  /** 删除话题（连同其消息与摘要） */
  app.delete('/api/conversations/:id', (c) => {
    const id = c.req.param('id');
    const conv = store.getConversation(id);
    if (!conv) return c.json({ ok: false, error: '话题不存在' }, 404);
    const total = store.listConversations(conv.scope, { includeArchived: true }).length;
    if (total <= 1) return c.json({ ok: false, error: '至少要保留一个话题' }, 400);
    store.deleteConversation(id);
    return c.json({ ok: true, message: '话题已删除' });
  });

  // ==================== 表情包 ====================
  /** 表情包库统一入口：优先用运行中的实例，没有就临时建一个（只读场景） */
  const getStickerLib = (): { lib: StickerLibrary; dir: string } => {
    const live = deps.stickers?.();
    if (live) return { lib: live, dir: live.root };
    const dir = path.resolve(PROJECT_ROOT, cfg.sticker.dir);
    return { lib: new StickerLibrary(dir, log, cfg.sticker.manifest), dir };
  };

  /** 列出表情包（含 AI 识别出的描述与标签分组） */
  app.get('/api/stickers', (c) => {
    try {
      const { lib, dir } = getStickerLib();
      const byTag: Record<string, number> = {};
      for (const t of lib.tags()) byTag[t] = lib.countOf(t);

      return c.json({
        ok: true,
        enabled: cfg.sticker.enabled,
        dir: cfg.sticker.dir,
        dirExists: fs.existsSync(dir),
        manifest: cfg.sticker.manifest,
        manifestExists: fs.existsSync(lib.manifestFile),
        count: lib.usable().length,
        total: lib.list().length,
        understood: lib.understood().length,
        pending: lib.pending().length,
        qqSourced: lib.list().filter((s) => s.source === 'qq' && !s.missing).length,
        missing: lib.list().filter((s) => s.missing).length,
        tags: byTag,
        maxPerReply: cfg.sticker.maxPerReply,
        autoSend: cfg.sticker.autoSend,
        autoOnEmotions: cfg.sticker.autoOnEmotions,
        files: lib.list().map((s) => ({
          file: s.file,
          name: path.basename(s.file),
          tags: s.tags,
          desc: s.desc,
          useWhen: s.useWhen,
          emotions: s.emotions,
          source: s.source,
          size: s.size,
          missing: s.missing,
          analyzed: Boolean(s.desc.trim()),
          emojiId: s.emojiId ?? '',
          resId: s.resId ?? '',
          md5: s.md5 ?? '',
          /** 面板 <img> 用；带 token 以适配开启鉴权的情况 */
          url: `/api/stickers/file?path=${encodeURIComponent(s.file)}${
            cfg.server.authToken ? `&token=${encodeURIComponent(cfg.server.authToken)}` : ''
          }`,
        })),
        policy: {
          maxTagsInPrompt: cfg.sticker.maxTagsInPrompt,
          descCharsInPrompt: cfg.sticker.descCharsInPrompt,
        },
      });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /**
   * 取单张表情包图片。
   *
   * 路径必须落在表情包目录内 —— 面板传上来的 path 是不可信输入，
   * 不加这道校验就等于把整个磁盘开放读了。
   */
  app.get('/api/stickers/file', (c) => {
    try {
      const { lib, dir } = getStickerLib();
      const rel = c.req.query('path') ?? '';
      if (!rel) return c.json({ ok: false, error: '缺少 path' }, 400);

      const abs = safeRelPath(dir, rel);
      if (!abs) return c.json({ ok: false, error: '非法路径' }, 400);

      // 也校验一下是不是库里的条目，避免通过符号链接之类的旁路
      if (!lib.get(rel)) return c.json({ ok: false, error: '表情包不存在' }, 404);
      if (!fs.existsSync(abs)) return c.json({ ok: false, error: '文件已丢失' }, 404);

      const buf = fs.readFileSync(abs);
      const mime = sniffMime(buf);
      return new Response(new Uint8Array(buf), {
        headers: {
          'content-type': mime,
          'cache-control': 'no-cache',
        },
      });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 重新扫描表情包目录（用户往目录里放了新图后点一下） */
  app.post('/api/stickers/reload', async (c) => {
    try {
      const count = deps.reloadStickers ? await deps.reloadStickers() : getStickerLib().lib.reload();
      const { lib } = getStickerLib();
      return c.json({
        ok: true,
        count,
        tags: lib.tags().length,
        message: `已重新扫描：${lib.usable().length} 张图、${lib.tags().length} 个标签`,
      });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 从 QQ 收藏导入表情包（拉列表 → 下载到本地 → 写 manifest） */
  app.post('/api/stickers/import-qq', async (c) => {
    if (!deps.importQqStickers) {
      return c.json({ ok: false, error: '导入功能未接线' }, 501);
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
      const limit = Math.max(1, Math.min(Number(body.limit) || 48, 500));
      const result = await deps.importQqStickers(limit);
      return c.json({ ...result, ok: result.added > 0 || result.skipped > 0 });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 用视觉模型识别表情包含义（写回 manifest） */
  app.post('/api/stickers/analyze', async (c) => {
    if (!deps.analyzeStickers) {
      return c.json({ ok: false, error: '识别功能未接线' }, 501);
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        force?: boolean;
        limit?: number;
        files?: string[];
      };
      const result = await deps.analyzeStickers({
        force: Boolean(body.force),
        ...(body.limit ? { limit: Math.max(1, Math.min(Number(body.limit), 500)) } : {}),
        ...(Array.isArray(body.files) && body.files.length ? { files: body.files.map(String) } : {}),
      });
      return c.json({ ...result, ok: result.failed === 0 });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 手动改一张表情包的标签/描述/情绪 */
  app.post('/api/stickers/entry', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        file?: string;
        tags?: string[];
        desc?: string;
        useWhen?: string;
        emotions?: string[];
      };
      const rel = String(body.file ?? '');
      const { lib } = getStickerLib();
      const cur = lib.get(rel);
      if (!cur) return c.json({ ok: false, error: '表情包不存在' }, 404);

      lib.upsert([
        {
          file: cur.file,
          tags: (body.tags ?? cur.tags).map((t) => String(t).trim()).filter(Boolean).slice(0, 6),
          desc: String(body.desc ?? cur.desc).slice(0, 100),
          useWhen: String(body.useWhen ?? cur.useWhen).slice(0, 100),
          emotions: (body.emotions ?? cur.emotions).map((t) => String(t).trim()).filter(Boolean),
          source: cur.source,
          ...(cur.resId ? { resId: cur.resId } : {}),
          ...(cur.md5 ? { md5: cur.md5 } : {}),
          ...(cur.emojiId ? { emojiId: cur.emojiId } : {}),
          ...(cur.url ? { url: cur.url } : {}),
          ...(cur.analyzedAt !== undefined ? { analyzedAt: cur.analyzedAt } : {}),
          ...(cur.analyzedBy ? { analyzedBy: cur.analyzedBy } : {}),
        },
      ]);
      return c.json({ ok: true, message: '已保存' });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 删除表情包（文件 + manifest 记录） */
  app.post('/api/stickers/delete', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { files?: string[]; file?: string };
      const list = (body.files ?? (body.file ? [body.file] : [])).map(String);
      if (list.length === 0) return c.json({ ok: false, error: '未指定文件' }, 400);

      const { lib, dir } = getStickerLib();
      let removed = 0;
      for (const rel of list) {
        const cur = lib.get(rel);
        if (!cur) continue;
        const abs = safeRelPath(dir, cur.file);
        if (!abs) continue;
        try {
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
          removed++;
        } catch (e) {
          log.warn({ file: rel, err: (e as Error).message }, '删除表情包文件失败');
        }
      }
      lib.forget(list);
      lib.reload();
      return c.json({ ok: true, removed, message: `已删除 ${removed} 张` });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /** 把 AI 写好的描述回写到 QQ 自带的收藏表情描述 */
  app.post('/api/stickers/push-desc', async (c) => {
    if (!deps.pushStickerDesc) return c.json({ ok: false, error: '未接线' }, 501);
    try {
      const r = await deps.pushStickerDesc();
      return c.json({ ...r, ok: r.failed === 0, message: `回写成功 ${r.ok} 张，失败 ${r.failed} 张` });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  // ==================== 记忆 ====================
  app.get('/api/users', (c) => {
    const users = store.listUsers(300).map((u) => {
      const facts = store.getFactsByUser(u.user_id, { limit: 1000 }).length;
      return {
        userId: u.user_id,
        nickname: u.nickname,
        aliases: safeJson(u.aliases),
        firstSeen: u.first_seen,
        lastSeen: u.last_seen,
        messageCount: u.message_count,
        personaId: u.persona_id,
        notes: u.notes,
        factCount: facts,
      };
    });
    return c.json({ ok: true, users });
  });

  app.get('/api/users/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ ok: false, error: '非法 QQ 号' }, 400);

    const user = store.getUser(id);
    if (!user) return c.json({ ok: false, error: '用户不存在' }, 404);

    const facts = store.getFactsByUser(id, { limit: 300 }).map((f) => ({
      id: f.id,
      factType: f.fact_type,
      factTypeCn: FACT_TYPE_CN[f.fact_type] ?? f.fact_type,
      content: f.content,
      keywords: f.keywords,
      confidence: f.confidence,
      shareable: f.shareable === 1,
      scope: f.scope,
      createdAt: f.created_at,
      hitCount: f.hit_count,
    }));

    // 该用户参与过的会话
    const sessions = store
      .listSessions(300)
      .filter((s) => store.countUserMessages(s.scope, id) > 0)
      .map((s) => ({
        scope: s.scope,
        scopeType: s.scope_type,
        title: s.title,
        messageCount: store.countUserMessages(s.scope, id),
        lastActive: s.last_active,
        emotion: store.getEmotionState(id, s.scope)
          ? {
              label: store.getEmotionState(id, s.scope)!.label,
              labelCn: EMOTION_LABELS_CN[store.getEmotionState(id, s.scope)!.label] ?? '',
              valence: store.getEmotionState(id, s.scope)!.valence,
              arousal: store.getEmotionState(id, s.scope)!.arousal,
              dominance: store.getEmotionState(id, s.scope)!.dominance,
              intensity: store.getEmotionState(id, s.scope)!.intensity,
            }
          : null,
      }));

    return c.json({
      ok: true,
      user: {
        userId: user.user_id,
        nickname: user.nickname,
        aliases: safeJson(user.aliases),
        firstSeen: user.first_seen,
        lastSeen: user.last_seen,
        messageCount: user.message_count,
        personaId: user.persona_id,
        notes: user.notes,
      },
      facts,
      sessions,
    });
  });

  app.delete('/api/facts/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ ok: false, error: '非法 id' }, 400);
    store.deleteFact(id);
    return c.json({ ok: true });
  });

  /** 搜索记忆 */
  app.get('/api/memory/search', (c) => {
    const q = c.req.query('q') ?? '';
    const userId = Number(c.req.query('userId') ?? '');
    if (!q.trim()) return c.json({ ok: true, facts: [], messages: [] });

    const facts = Number.isFinite(userId)
      ? store.searchFacts(userId, q, { limit: 30 })
      : store.listFacts(undefined, 500).filter((f) => f.content.includes(q) || f.keywords.includes(q)).slice(0, 30);

    const messages = store.searchMessages(q, 30);
    return c.json({
      ok: true,
      facts: facts.map((f) => ({
        id: f.id,
        userId: f.user_id,
        factType: f.fact_type,
        factTypeCn: FACT_TYPE_CN[f.fact_type] ?? f.fact_type,
        content: f.content,
        confidence: f.confidence,
        scope: f.scope,
        shareable: f.shareable === 1,
        createdAt: f.created_at,
      })),
      messages: messages.map((m) => ({
        id: m.id,
        scope: m.scope,
        userId: m.user_id,
        role: m.role,
        content: m.content,
        senderName: m.sender_name,
        createdAt: m.created_at,
        emotionLabel: m.emotion_label,
      })),
    });
  });

  /** 某会话的消息 */
  app.get('/api/sessions/:scope/messages', (c) => {
    const scope = decodeURIComponent(c.req.param('scope'));
    const limit = Math.min(500, Number(c.req.query('limit') ?? 100));
    const messages = store.getRecentMessages(scope, limit).map((m) => ({
      id: m.id,
      userId: m.user_id,
      role: m.role,
      content: m.content,
      senderName: m.sender_name,
      tokens: m.tokens,
      emotionLabel: m.emotion_label,
      emotionIntensity: m.emotion_intensity,
      summarized: m.summarized === 1,
      createdAt: m.created_at,
    }));
    const summaries = store.getSummaries(scope, undefined, 20).map((s) => ({
      id: s.id,
      level: s.level,
      content: s.content,
      msgCount: s.msg_count,
      createdAt: s.created_at,
    }));
    return c.json({ ok: true, messages, summaries });
  });

  /** 情绪曲线 */
  app.get('/api/users/:id/emotion', (c) => {
    const id = Number(c.req.param('id'));
    const scope = c.req.query('scope');
    const limit = Math.min(500, Number(c.req.query('limit') ?? 100));
    const history = store.getEmotionHistory(id, scope ? { scope, limit } : { limit });
    return c.json({
      ok: true,
      history: history.reverse().map((h) => ({
        label: h.label,
        labelCn: EMOTION_LABELS_CN[h.label] ?? h.label,
        valence: h.valence,
        arousal: h.arousal,
        dominance: h.dominance,
        intensity: h.intensity,
        createdAt: h.created_at,
      })),
    });
  });

  /** 群成员 */
  app.get('/api/groups/:id/members', (c) => {
    const gid = Number(c.req.param('id'));
    if (!Number.isFinite(gid)) return c.json({ ok: false, error: '非法群号' }, 400);
    return c.json({ ok: true, members: store.listGroupMembers(gid, 200) });
  });

  // ==================== 日志 ====================
  app.get('/api/logs', (c) => {
    const lines = Math.min(1000, Number(c.req.query('lines') ?? 200));
    const logDir = path.resolve(PROJECT_ROOT, cfg.storage.logDir);
    try {
      if (!fs.existsSync(logDir)) return c.json({ ok: true, lines: [] });
      const files = fs
        .readdirSync(logDir)
        .filter((f) => f.endsWith('.log'))
        .sort();
      const latest = files[files.length - 1];
      if (!latest) return c.json({ ok: true, lines: [], file: '' });
      const content = fs.readFileSync(path.join(logDir, latest), 'utf8');
      const all = content.split(/\r?\n/).filter(Boolean);
      return c.json({ ok: true, file: latest, lines: all.slice(-lines) });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  // ==================== 前端 ====================
  app.get('/', (c) => c.html(getPanelHtml()));
  app.get('/panel', (c) => c.html(getPanelHtml()));

  let server: ReturnType<typeof serve> | null = null;

  return {
    app,
    start: () => {
      if (!cfg.server.enabled) {
        log.info('管理面板已禁用（server.enabled=false）');
        return;
      }
      server = serve({ fetch: app.fetch, hostname: cfg.server.host, port: cfg.server.port }, (info) => {
        log.info({ url: `http://${cfg.server.host}:${info.port}` }, '🖥  管理面板已启动');
      });
    },
    stop: () => {
      if (server) {
        server.close();
        server = null;
      }
    },
  };
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}***${key.slice(-4)}`;
}

function safeJson(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
