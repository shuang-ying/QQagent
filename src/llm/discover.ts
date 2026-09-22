/**
 * 模型自动发现
 *
 * 用户只给一个 URL + Key，本模块负责找出：
 *   1. 这个地址该用哪种协议（OpenAI 兼容 / Anthropic / Gemini / Ollama）
 *   2. 它提供哪些可用模型
 *
 * 策略：按协议顺序逐个尝试候选端点，任一成功即返回，
 * 并记录完整探测轨迹（面板上能看到"为什么失败"）。
 */
import type { DiscoveredModel, DiscoverResult, Protocol } from '../core/types.js';
import { AUTO_ORDER, candidateApiRoots, getAdapter, inferModelMeta } from './protocol.js';
import { normalizeBaseUrl } from '../config/loader.js';

export interface DiscoverOptions {
  baseURL: string;
  apiKey: string;
  /** auto 或指定协议 */
  protocol?: Protocol;
  /** 额外请求头 */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 允许自签名证书 / 忽略 TLS 错误（本地常见） */
  allowInsecureTls?: boolean;
}

type Attempt = DiscoverResult['attempts'][number];

/** 用 AbortController 实现超时，避免请求悬挂 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 探测单个端点 */
async function probeEndpoint(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number | null; json?: unknown; note: string }> {
  try {
    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers: { Accept: 'application/json', ...headers } },
      timeoutMs,
    );
    const text = await res.text();

    if (!res.ok) {
      // 把服务端的错误摘要带出来，用户能看懂 401/404 的区别
      let note = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        const msg =
          (j['error'] as Record<string, unknown>)?.['message'] ??
          j['message'] ??
          j['error'] ??
          j['detail'];
        if (msg) note += ` - ${String(msg).slice(0, 160)}`;
      } catch {
        if (text) note += ` - ${text.slice(0, 160)}`;
      }
      return { ok: false, status: res.status, note };
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, note: `响应不是 JSON: ${text.slice(0, 120)}` };
    }
    return { ok: true, status: res.status, json, note: 'OK' };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.cause?.code ?? err.name;
    let note: string;
    if (err.name === 'AbortError') note = `请求超时(${timeoutMs}ms)`;
    else if (code === 'ENOTFOUND') note = '域名解析失败，URL 可能写错或无法联网';
    else if (code === 'ECONNREFUSED') note = '连接被拒绝，服务未启动或端口错误';
    else if (code === 'CERT_HAS_EXPIRED' || String(code).includes('CERT')) note = `TLS 证书问题: ${code}`;
    else note = err.message || String(code);
    return { ok: false, status: null, note };
  }
}

/**
 * 核心：发现模型列表
 */
export async function discoverModels(opts: DiscoverOptions): Promise<DiscoverResult> {
  const baseURL = normalizeBaseUrl(opts.baseURL);
  const timeoutMs = opts.timeoutMs ?? 15000;
  const extra = opts.headers ?? {};
  const attempts: Attempt[] = [];

  const protocols: Array<Exclude<Protocol, 'auto'>> =
    !opts.protocol || opts.protocol === 'auto' ? AUTO_ORDER : [opts.protocol];

  const roots = candidateApiRoots(baseURL);

  for (const proto of protocols) {
    const adapter = getAdapter(proto);
    const auth = adapter.authHeaders(opts.apiKey);

    for (const root of roots) {
      for (const endpoint of adapter.modelEndpoints(root)) {
        const headers = { ...auth, ...extra };
        const r = await probeEndpoint(endpoint, headers, timeoutMs);

        if (!r.ok) {
          attempts.push({ url: endpoint, protocol: proto, status: r.status, ok: false, note: r.note });
          continue;
        }

        let models: DiscoveredModel[];
        try {
          models = adapter.parseModels(r.json);
        } catch (e) {
          attempts.push({
            url: endpoint,
            protocol: proto,
            status: r.status,
            ok: false,
            note: `解析模型列表失败: ${(e as Error).message}`,
          });
          continue;
        }

        if (models.length === 0) {
          attempts.push({
            url: endpoint,
            protocol: proto,
            status: r.status,
            ok: false,
            note: '接口返回成功但未解析出任何模型（可能字段结构不同）',
          });
          continue;
        }

        attempts.push({ url: endpoint, protocol: proto, status: r.status, ok: true, note: `发现 ${models.length} 个模型` });
        return { ok: true, protocol: proto, models: dedupeModels(models), attempts };
      }
    }
  }

  // 全部失败：给出可操作的错误摘要
  const authFailed = attempts.some((a) => a.status === 401 || a.status === 403);
  const notFound = attempts.every((a) => a.status === 404 || a.status === null || a.status === 405);

  let error: string;
  if (authFailed) {
    error = '鉴权失败（401/403）：API Key 不正确或已过期，请检查 Key。';
  } else if (notFound) {
    error = '所有候选端点都返回 404/无法连接：URL 可能不正确，或该服务不提供 /models 列表接口。可改用「手动添加模型」。';
  } else {
    error = '未能自动发现模型，请查看下方探测详情。';
  }

  // 失败时 protocol 字段回退为尝试列表的首个协议，便于前端展示
  const fallbackProtocol: Exclude<Protocol, 'auto'> = protocols[0] ?? 'openai';
  return { ok: false, protocol: fallbackProtocol, models: [], attempts, error };
}

/** 去重并按 id 排序，保持稳定输出 */
export function dedupeModels(models: DiscoveredModel[]): DiscoveredModel[] {
  const map = new Map<string, DiscoveredModel>();
  for (const m of models) {
    if (!map.has(m.id)) map.set(m.id, m);
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 连通性自检：不依赖 /models 接口，直接发一条最小对话请求。
 * 用于「列表接口不可用但对话接口可用」的中转站。
 */
export async function testChat(
  baseURL: string,
  apiKey: string,
  model: string,
  protocol: Exclude<Protocol, 'auto'> = 'openai',
  timeoutMs = 30000,
): Promise<{ ok: boolean; reply: string; error?: string; latencyMs: number }> {
  const root = normalizeBaseUrl(baseURL);
  const adapter = getAdapter(protocol);
  const url = adapter.chatEndpoint(root);
  const start = Date.now();

  let body: Record<string, unknown>;
  // 注意：这里不能只给 16 个 token。推理模型会先输出思维链，
  // 预算太小会导致正文为空，连通性自检就会误判为"没回复"。
  const probeTokens = 256;
  if (protocol === 'anthropic') {
    body = { model, max_tokens: probeTokens, messages: [{ role: 'user', content: 'hi' }] };
  } else if (protocol === 'gemini') {
    body = { contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: probeTokens } };
  } else if (protocol === 'ollama') {
    body = { model, messages: [{ role: 'user', content: 'hi' }], stream: false, options: { num_predict: probeTokens } };
  } else {
    body = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: probeTokens };
  }

  const finalUrl = protocol === 'gemini' ? `${url}/${model}:generateContent` : url;

  try {
    const res = await fetchWithTimeout(
      finalUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adapter.authHeaders(apiKey) },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    const text = await res.text();
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      return { ok: false, reply: '', error: `HTTP ${res.status}: ${text.slice(0, 200)}`, latencyMs };
    }

    const json = JSON.parse(text) as Record<string, unknown>;
    let reply = '';
    if (protocol === 'anthropic') {
      const content = json['content'] as Array<Record<string, unknown>> | undefined;
      reply = String(content?.[0]?.['text'] ?? '');
    } else if (protocol === 'gemini') {
      const cands = json['candidates'] as Array<Record<string, unknown>> | undefined;
      const parts = (cands?.[0]?.['content'] as Record<string, unknown>)?.['parts'] as
        | Array<Record<string, unknown>>
        | undefined;
      reply = String(parts?.[0]?.['text'] ?? '');
    } else if (protocol === 'ollama') {
      reply = String((json['message'] as Record<string, unknown>)?.['content'] ?? '');
    } else {
      const choices = json['choices'] as Array<Record<string, unknown>> | undefined;
      reply = String((choices?.[0]?.['message'] as Record<string, unknown>)?.['content'] ?? '');
    }
    return { ok: true, reply, latencyMs };
  } catch (e) {
    return { ok: false, reply: '', error: (e as Error).message, latencyMs: Date.now() - start };
  }
}

/** 供面板使用：仅按 model id 推断元数据 */
export { inferModelMeta };
