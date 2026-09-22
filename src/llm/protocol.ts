/**
 * 多协议适配层
 *
 * 支持 OpenAI 兼容 / Anthropic / Gemini / Ollama 四种协议：
 *  - 生成请求的 URL、鉴权头、请求体构造
 *  - 模型列表端点的候选 URL、鉴权头、响应解析
 *
 * 「任意 API」的关键：不同厂商/中转站的路径与鉴权差异全部收敛在这里。
 */
import type { DiscoveredModel, Protocol } from '../core/types.js';

export interface ProtocolAdapter {
  id: Protocol;
  label: string;
  /** 模型列表候选端点（按优先级） */
  modelEndpoints: (apiRoot: string) => string[];
  /** 鉴权相关请求头 */
  authHeaders: (apiKey: string) => Record<string, string>;
  /** 解析模型列表响应 */
  parseModels: (json: unknown) => DiscoveredModel[];
  /** 对话端点 */
  chatEndpoint: (apiRoot: string) => string;
}

/** 从 baseURL 推导可能的 API 根路径 */
export function candidateApiRoots(base: string): string[] {
  const b = base.replace(/\/+$/, '');
  const roots = new Set<string>();
  roots.add(b);

  const hasVersion = /\/v\d+(beta)?$/i.test(b);
  if (!hasVersion) {
    roots.add(`${b}/v1`);
    roots.add(`${b}/v1beta`);
    if (/\/api$/i.test(b)) roots.add(b.replace(/\/api$/i, '') + '/v1');
  } else if (/\/v1beta$/i.test(b)) {
    roots.add(b.replace(/\/v1beta$/i, '/v1'));
  }
  return [...roots];
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 从模型 id 推断元数据。
 * 各家的上下文窗口/能力差异大，这里用启发式给一个合理默认，
 * 允许在配置里手动覆盖。
 */
/**
 * 用户手工指定的模型能力覆盖。
 * 键是模型 id（小写匹配），值可指定 vision / noVision / contextWindow。
 *
 * 为什么需要它：能力推断只能靠模型名，而中转站经常改名
 * （例如把 `deepseek-flash` 叫成 `deepseek-v4.1-flash`），
 * 一旦猜错就会把能读图的模型当成不能读。有了这个兜底，
 * 用户不用等我改代码就能自己纠正。
 */
export interface ModelOverride {
  vision?: boolean;
  contextWindow?: number;
}

/** 全局覆盖表，由配置注入（键为小写模型名） */
let modelOverrides: Record<string, ModelOverride> = {};

/** 注入模型能力覆盖（启动时调用一次） */
export function setModelOverrides(map: Record<string, ModelOverride> | undefined): void {
  modelOverrides = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    modelOverrides[k.toLowerCase()] = v;
  }
}

/** 取某模型命中的覆盖项（支持精确匹配与“包含”匹配） */
function findOverride(s: string): ModelOverride | undefined {
  if (modelOverrides[s]) return modelOverrides[s];
  for (const [k, v] of Object.entries(modelOverrides)) {
    if (s.includes(k)) return v;
  }
  return undefined;
}

export function inferModelMeta(id: string): {
  contextWindow?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsStream: boolean;
  tags: string[];
} {
  const s = id.toLowerCase();
  const tags: string[] = [];

  // 供应商标签
  if (/claude|\[an\]/.test(s)) tags.push('anthropic');
  else if (/gemini|\[gg\]/.test(s)) tags.push('google');
  else if (/gpt|o[134]-|davinci|\[oa\]/.test(s)) tags.push('openai');
  else if (/deepseek/.test(s)) tags.push('deepseek');
  else if (/qwen|qwq|tongyi/.test(s)) tags.push('qwen');
  else if (/glm|chatglm/.test(s)) tags.push('glm');
  else if (/kimi|moonshot/.test(s)) tags.push('kimi');
  else if (/llama|mixtral|mistral/.test(s)) tags.push('llama');
  else if (/doubao|seed/.test(s)) tags.push('doubao');
  else if (/minimax|abab/.test(s)) tags.push('minimax');
  else if (/longcat/.test(s)) tags.push('longcat');
  else if (/mimo/.test(s)) tags.push('mimo');
  else if (/hy\d|hunyuan/.test(s)) tags.push('hunyuan');

  // 能力标签
  // 注意：不能只靠名字里的 "vision" 字面匹配，很多多模态模型名字里并没有它。
  // 这里列的是「按官方文档确认支持图像输入」的模型家族：
  //   - Claude 3+ / Gemini 全系：原生多模态
  //   - GPT-4o / 4.1 / 5 / o3o4
  //   - DeepSeek Flash：官方文档《图像理解》明确支持图片输入
  //     （旧名 deepseek-v4-flash-vision-exp 已下线，请求由最新 Flash 承接）
  // 名字启发式永远可能漏判/误判（中转站还会改名），
  // 所以另外提供 llm.modelOverrides 让用户手工纠正。
  const isMultimodalFamily =
    tags.includes('anthropic') ||
    tags.includes('google') ||
    /gpt-4o|gpt-4\.1|gpt-5|o[34]-/.test(s) ||
    /deepseek[^/]*flash/.test(s);
  if (isMultimodalFamily || /vision|vl|-v$|omni|multimodal/.test(s)) tags.push('vision');
  if (/thinking|reason|-r1|reasoner|o[13]/.test(s)) tags.push('reasoning');
  if (/code|coder/.test(s)) tags.push('code');
  if (/embed/.test(s)) tags.push('embedding');
  if (/diffusion|nai-|sd|image|dall|flux/.test(s)) tags.push('image');
  if (/tts|audio|whisper|speech/.test(s)) tags.push('audio');
  if (/rerank/.test(s)) tags.push('rerank');

  const supportsVision = tags.includes('vision');
  const supportsTools =
    !tags.includes('embedding') && !tags.includes('image') && !tags.includes('audio') && !tags.includes('rerank');
  const supportsStream =
    !tags.includes('embedding') && !tags.includes('image') && !tags.includes('rerank');

  // 上下文窗口启发式
  let contextWindow: number | undefined;
  if (/\[an\]|claude/.test(s)) contextWindow = 200000;
  else if (/gemini/.test(s)) contextWindow = 1000000;
  else if (/gpt-4|gpt-5|o[13]/.test(s)) contextWindow = 128000;
  else if (/deepseek/.test(s)) contextWindow = 128000;
  else if (/qwen.*max|qwen3/.test(s)) contextWindow = 128000;
  else if (/glm-4|glm-5/.test(s)) contextWindow = 128000;
  else if (/kimi/.test(s)) contextWindow = 128000;
  else if (/doubao/.test(s)) contextWindow = 128000;

  // ---- 用户覆盖优先于名字推断 ----
  const ov = findOverride(s);
  let finalVision = supportsVision;
  if (ov?.vision !== undefined) {
    finalVision = ov.vision;
    if (ov.vision && !tags.includes('vision')) tags.push('vision');
    if (!ov.vision) {
      const i = tags.indexOf('vision');
      if (i >= 0) tags.splice(i, 1);
    }
  }
  if (ov?.contextWindow !== undefined) contextWindow = ov.contextWindow;

  return { contextWindow, supportsVision: finalVision, supportsTools, supportsStream, tags };
}

/** 统一构造 DiscoveredModel，避免各适配器重复代码 */
function toModel(
  id: string,
  name: string,
  meta: ReturnType<typeof inferModelMeta>,
  overrides: Partial<DiscoveredModel> = {},
): DiscoveredModel {
  const model: DiscoveredModel = {
    id,
    name,
    supportsStream: meta.supportsStream,
    tags: meta.tags,
  };
  const ctx = overrides.contextWindow ?? meta.contextWindow;
  if (typeof ctx === 'number') model.contextWindow = ctx;
  const vision = overrides.supportsVision ?? meta.supportsVision;
  if (vision !== undefined) model.supportsVision = vision;
  const tools = overrides.supportsTools ?? meta.supportsTools;
  if (tools !== undefined) model.supportsTools = tools;
  if (overrides.supportsStream !== undefined) model.supportsStream = overrides.supportsStream;
  if (overrides.tags) model.tags = overrides.tags;
  return model;
}

// ============================================================
// OpenAI 兼容（绝大多数中转站）
// ============================================================
const openaiAdapter: ProtocolAdapter = {
  id: 'openai',
  label: 'OpenAI 兼容',
  modelEndpoints: (root) => [`${root}/models`],
  authHeaders: (key): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {}),
  chatEndpoint: (root) => `${root}/chat/completions`,
  parseModels: (json) => {
    const obj = json as Record<string, unknown>;
    const list = asArray(obj['data']).length ? asArray(obj['data']) : asArray(obj['models']);
    const out: DiscoveredModel[] = [];
    for (const m of list) {
      const o = m as Record<string, unknown>;
      const id = str(o['id']) || str(o['name']) || str(o['model']);
      if (!id) continue;
      out.push(toModel(id, str(o['name']) || id, inferModelMeta(id)));
    }
    return out;
  },
};

// ============================================================
// Anthropic 原生
// ============================================================
const anthropicAdapter: ProtocolAdapter = {
  id: 'anthropic',
  label: 'Anthropic',
  modelEndpoints: (root) => [`${root}/models`],
  authHeaders: (key): Record<string, string> => ({
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  }),
  chatEndpoint: (root) => (root.endsWith('/v1') ? `${root}/messages` : `${root}/v1/messages`),
  parseModels: (json) => {
    const obj = json as Record<string, unknown>;
    const out: DiscoveredModel[] = [];
    for (const m of asArray(obj['data'])) {
      const o = m as Record<string, unknown>;
      const id = str(o['id']);
      if (!id) continue;
      const meta = inferModelMeta(id);
      const tags = meta.tags.includes('anthropic') ? meta.tags : [...meta.tags, 'anthropic'];
      out.push(
        toModel(id, str(o['display_name']) || id, meta, {
          contextWindow: meta.contextWindow ?? 200000,
          supportsVision: true,
          supportsTools: true,
          supportsStream: true,
          tags,
        }),
      );
    }
    return out;
  },
};

// ============================================================
// Google Gemini 原生
// ============================================================
const geminiAdapter: ProtocolAdapter = {
  id: 'gemini',
  label: 'Google Gemini',
  modelEndpoints: (root) => [`${root}/models`],
  authHeaders: (key): Record<string, string> => (key ? { 'x-goog-api-key': key } : {}),
  chatEndpoint: (root) => (root.endsWith('/v1beta') ? `${root}/models` : `${root}/v1beta/models`),
  parseModels: (json) => {
    const obj = json as Record<string, unknown>;
    const out: DiscoveredModel[] = [];
    for (const m of asArray(obj['models'])) {
      const o = m as Record<string, unknown>;
      // name 形如 "models/gemini-pro"
      const raw = str(o['name']);
      const id = raw.replace(/^models\//, '');
      if (!id) continue;
      const methods = asArray(o['supportedGenerationMethods']).map(String);
      const meta = inferModelMeta(id);
      const tags = meta.tags.includes('google') ? meta.tags : [...meta.tags, 'google'];
      const overrides: Partial<DiscoveredModel> = {
        supportsTools: methods.includes('generateContent'),
        supportsStream: methods.includes('streamGenerateContent'),
        tags,
      };
      if (typeof o['inputTokenLimit'] === 'number') overrides.contextWindow = o['inputTokenLimit'] as number;
      out.push(toModel(id, str(o['displayName']) || id, meta, overrides));
    }
    return out;
  },
};

// ============================================================
// Ollama 本地
// ============================================================
const ollamaAdapter: ProtocolAdapter = {
  id: 'ollama',
  label: 'Ollama',
  modelEndpoints: (root) => {
    const b = root.replace(/\/v1$/, '');
    return [`${b}/api/tags`];
  },
  authHeaders: (key): Record<string, string> =>
    key && key !== 'ollama' ? { Authorization: `Bearer ${key}` } : {},
  chatEndpoint: (root) => {
    const b = root.replace(/\/v1$/, '');
    return `${b}/api/chat`;
  },
  parseModels: (json) => {
    const obj = json as Record<string, unknown>;
    const out: DiscoveredModel[] = [];
    for (const m of asArray(obj['models'])) {
      const o = m as Record<string, unknown>;
      const id = str(o['name']) || str(o['model']);
      if (!id) continue;
      const meta = inferModelMeta(id);
      out.push(
        toModel(id, id, meta, {
          contextWindow: meta.contextWindow ?? 8192,
          supportsTools: true,
          supportsStream: true,
          tags: ['ollama', ...meta.tags],
        }),
      );
    }
    return out;
  },
};

export const ADAPTERS: Record<Exclude<Protocol, 'auto'>, ProtocolAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  ollama: ollamaAdapter,
};

/** auto 模式下的探测顺序：OpenAI 兼容优先（覆盖最广） */
export const AUTO_ORDER: Array<Exclude<Protocol, 'auto'>> = ['openai', 'anthropic', 'gemini', 'ollama'];

export function getAdapter(p: Exclude<Protocol, 'auto'>): ProtocolAdapter {
  return ADAPTERS[p];
}
