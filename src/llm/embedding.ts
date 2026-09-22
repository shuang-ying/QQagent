/**
 * 向量化（embedding）客户端
 *
 * 单独成模块而不是塞进 ProtocolAdapter：四个对话适配器已经很稳定，
 * 而 embedding 的实际用法高度集中在 OpenAI 兼容的 /embeddings 上。
 * 这里按 protocol 分派到对应端点，未支持的形式给出明确中文错误。
 */
import type { Protocol } from '../core/types.js';

export interface EmbedResult {
  ok: boolean;
  vectors: number[][];
  error?: string;
  latencyMs: number;
}

type Ep = Exclude<Protocol, 'auto'>;

function authHeaders(p: Ep, apiKey: string): Record<string, string> {
  if (!apiKey) return { 'Content-Type': 'application/json' };
  if (p === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  }
  if (p === 'gemini') {
    return { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
  }
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

/** 解析各家 /embeddings 的返回结构 */
function parseVectors(p: Ep, json: unknown): number[][] {
  const j = json as Record<string, unknown>;

  // OpenAI 兼容：{ data: [{ embedding: [...] }] }
  if (Array.isArray(j?.data)) {
    return (j.data as Array<Record<string, unknown>>)
      .map((d) => (Array.isArray(d?.embedding) ? (d.embedding as number[]) : null))
      .filter((v): v is number[] => Array.isArray(v));
  }

  // Ollama：{ embeddings: [[...]] } 或 { embedding: [...] }
  if (Array.isArray(j?.embeddings)) {
    return (j.embeddings as unknown[]).filter((v): v is number[] => Array.isArray(v));
  }
  if (Array.isArray(j?.embedding)) return [j.embedding as number[]];

  // Gemini batch：{ embeddings: [{ values: [...] }] }
  if (Array.isArray(j?.embeddings)) {
    return (j.embeddings as Array<Record<string, unknown>>)
      .map((d) => (Array.isArray(d?.values) ? (d.values as number[]) : null))
      .filter((v): v is number[] => Array.isArray(v));
  }

  throw new Error('无法解析 embedding 响应（结构不认识）');
}

/**
 * 计算若干文本的向量。
 */
export async function embedTexts(params: {
  baseURL: string;
  apiKey: string;
  protocol: Ep;
  model: string;
  texts: string[];
  timeoutMs?: number;
  headers?: Record<string, string>;
}): Promise<EmbedResult> {
  const { baseURL, apiKey, protocol, model, texts } = params;
  const timeoutMs = params.timeoutMs ?? 30000;
  const start = Date.now();
  const root = baseURL.replace(/\/+$/, '');

  if (!model) {
    return { ok: false, vectors: [], error: '未指定 embedding 模型', latencyMs: 0 };
  }
  if (texts.length === 0) {
    return { ok: true, vectors: [], latencyMs: 0 };
  }

  let url: string;
  let body: unknown;

  if (protocol === 'ollama') {
    url = `${root}/api/embed`;
    body = { model, input: texts };
  } else if (protocol === 'gemini') {
    url = `${root}/models/${encodeURIComponent(model)}:batchEmbedContents`;
    body = {
      requests: texts.map((t) => ({
        model: `models/${model}`,
        content: { parts: [{ text: t }] },
      })),
    };
  } else {
    // openai 及绝大多数中转站
    url = `${root}/embeddings`;
    body = { model, input: texts };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(protocol, apiKey), ...(params.headers ?? {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) {
      // 中转站常把 /embeddings 返回 404：给出可操作的提示
      if (res.status === 404) {
        return {
          ok: false,
          vectors: [],
          error: `该服务没有 /embeddings 接口（404）。请换一个支持向量化的供应商或模型。`,
          latencyMs: Date.now() - start,
        };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          vectors: [],
          error: `鉴权失败（${res.status}）：API Key 无效或无权使用该 embedding 模型。`,
          latencyMs: Date.now() - start,
        };
      }
      return {
        ok: false,
        vectors: [],
        error: `HTTP ${res.status}: ${text.slice(0, 300)}`,
        latencyMs: Date.now() - start,
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, vectors: [], error: '返回的不是合法 JSON', latencyMs: Date.now() - start };
    }

    const vectors = parseVectors(protocol, json);
    if (vectors.length !== texts.length) {
      return {
        ok: false,
        vectors,
        error: `返回向量数量(${vectors.length})与请求(${texts.length})不一致`,
        latencyMs: Date.now() - start,
      };
    }

    return { ok: true, vectors, latencyMs: Date.now() - start };
  } catch (e) {
    const msg = (e as Error).message;
    let hint = msg;
    if (/ENOTFOUND/i.test(msg)) hint = '域名无法解析，请检查地址';
    else if (/ECONNREFUSED/i.test(msg)) hint = '连接被拒绝，请确认服务是否在运行';
    else if (/abort|timeout/i.test(msg)) hint = '请求超时';
    return { ok: false, vectors: [], error: hint, latencyMs: Date.now() - start };
  }
}

/** 余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** number[] -> Float32Array 的 BLOB（用于 SQLite 存储） */
export function vectorToBlob(vec: number[]): Buffer {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/** BLOB -> number[] */
export function blobToVector(buf: Buffer | Uint8Array): number[] {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const f = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  return Array.from(f);
}
