/**
 * LLM 客户端
 *
 * 统一的对话接口，屏蔽 4 种协议差异：
 *   - OpenAI 兼容：POST {root}/chat/completions
 *   - Anthropic  ：POST {root}/v1/messages
 *   - Gemini     ：POST {root}/v1beta/models/{model}:streamGenerateContent
 *   - Ollama     ：POST {root}/api/chat
 *
 * 支持流式（SSE / NDJSON）与非流式，统一转成 async iterator 输出增量文本。
 */
import type { ChatMessage, ContentPart, LlmResult, LlmUsage, Protocol } from '../core/types.js';
import { contentToText } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import { getAdapter } from './protocol.js';
import { normalizeBaseUrl } from '../config/loader.js';

export interface ChatOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  protocol: Exclude<Protocol, 'auto'>;
  headers?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retriable = false,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** 把内部统一消息转成各协议的请求体 */
function buildRequestBody(
  protocol: Exclude<Protocol, 'auto'>,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
  stream: boolean,
): Record<string, unknown> {
  const temperature = opts.temperature;
  const maxTokens = opts.maxTokens;

  if (protocol === 'anthropic') {
    const systemParts = messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content));
    const rest = messages.filter((m) => m.role !== 'system');
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens ?? 1024,
      messages: rest.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
      stream,
    };
    if (systemParts.length) body['system'] = systemParts.join('\n\n');
    if (temperature !== undefined) body['temperature'] = temperature;
    return body;
  }

  if (protocol === 'gemini') {
    const systemParts = messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content));
    const rest = messages.filter((m) => m.role !== 'system');
    const body: Record<string, unknown> = {
      contents: rest.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: toGeminiParts(m.content),
      })),
      generationConfig: {
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
      },
    };
    if (systemParts.length) {
      body['systemInstruction'] = { parts: [{ text: systemParts.join('\n\n') }] };
    }
    return body;
  }

  if (protocol === 'ollama') {
    const body: Record<string, unknown> = {
      // Ollama 把图片放在独立的 images 数组里，content 仍然是纯文本
      messages: messages.map((m) => {
        const imgs = imagesOf(m.content);
        return {
          role: m.role,
          content: contentToText(m.content),
          ...(imgs.length ? { images: imgs.map((i) => i.data) } : {}),
        };
      }),
      stream,
    };
    if (temperature !== undefined || maxTokens !== undefined) {
      body['options'] = {
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { num_predict: maxTokens } : {}),
      };
    }
    return body;
  }

  // OpenAI 兼容
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: toOpenAiContent(m.content) })),
    stream,
  };
  if (temperature !== undefined) body['temperature'] = temperature;
  if (maxTokens !== undefined) body['max_tokens'] = maxTokens;
  if (stream) body['stream_options'] = { include_usage: true };
  return body;
}

/** 取出内容里的图片片段 */
function imagesOf(content: string | ContentPart[]): Array<{ mimeType: string; data: string }> {
  if (typeof content === 'string') return [];
  return content.filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image');
}

/** OpenAI 兼容：content 可以是字符串，也可以是 [{type:'text'|'image_url'}] */
function toOpenAiContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } },
  );
}

/** Anthropic：content 是 [{type:'text'|'image', source}] */
function toAnthropicContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } },
  );
}

/** Gemini：parts 是 [{text} | {inline_data}] */
function toGeminiParts(content: string | ContentPart[]): unknown[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((p) =>
    p.type === 'text'
      ? { text: p.text }
      : { inline_data: { mime_type: p.mimeType, data: p.data } },
  );
}

function buildUrl(protocol: Exclude<Protocol, 'auto'>, root: string, model: string, stream: boolean): string {
  const adapter = getAdapter(protocol);
  if (protocol === 'gemini') {
    const base = adapter.chatEndpoint(root); // {root}/v1beta/models
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    const alt = stream ? '&alt=sse' : '';
    const keyQs = ''; // key 走 header
    return `${base}/${encodeURIComponent(model)}:${method}?${keyQs}${alt}`.replace(/\?&/, '?').replace(/\?$/, '');
  }
  return adapter.chatEndpoint(root);
}

/** 从各协议的流式数据块中提取文本增量 */
function extractDelta(
  protocol: Exclude<Protocol, 'auto'>,
  json: Record<string, unknown>,
): { text: string; usage?: LlmUsage; finish?: string; reasoning?: string } {
  if (protocol === 'anthropic') {
    const type = json['type'];
    if (type === 'content_block_delta') {
      const delta = json['delta'] as Record<string, unknown> | undefined;
      return { text: String(delta?.['text'] ?? '') };
    }
    if (type === 'message_delta') {
      const usage = json['usage'] as Record<string, unknown> | undefined;
      const out = (usage?.['output_tokens'] as number) ?? 0;
      return {
        text: '',
        usage: { promptTokens: 0, completionTokens: out, totalTokens: out },
        finish: String((json['delta'] as Record<string, unknown>)?.['stop_reason'] ?? ''),
      };
    }
    if (type === 'message_start') {
      const msg = json['message'] as Record<string, unknown> | undefined;
      const usage = msg?.['usage'] as Record<string, unknown> | undefined;
      const inp = (usage?.['input_tokens'] as number) ?? 0;
      return { text: '', usage: { promptTokens: inp, completionTokens: 0, totalTokens: inp } };
    }
    return { text: '' };
  }

  if (protocol === 'gemini') {
    const cands = json['candidates'] as Array<Record<string, unknown>> | undefined;
    if (!cands?.length) {
      const um = json['usageMetadata'] as Record<string, unknown> | undefined;
      if (um) {
        const p = (um['promptTokenCount'] as number) ?? 0;
        const c = (um['candidatesTokenCount'] as number) ?? 0;
        return { text: '', usage: { promptTokens: p, completionTokens: c, totalTokens: p + c } };
      }
      return { text: '' };
    }
    const cand = cands[0]!;
    const parts = (cand['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>> | undefined;
    const text = (parts ?? []).map((p) => String(p['text'] ?? '')).join('');
    const finish = String(cand['finishReason'] ?? '');
    return { text, finish };
  }

  if (protocol === 'ollama') {
    const msg = json['message'] as Record<string, unknown> | undefined;
    const text = String(msg?.['content'] ?? '');
    const done = json['done'] === true;
    const usage: LlmUsage | undefined = done
      ? {
          promptTokens: (json['prompt_eval_count'] as number) ?? 0,
          completionTokens: (json['eval_count'] as number) ?? 0,
          totalTokens: ((json['prompt_eval_count'] as number) ?? 0) + ((json['eval_count'] as number) ?? 0),
        }
      : undefined;
    return { text, usage, finish: done ? 'stop' : '' };
  }

  // OpenAI
  const choices = json['choices'] as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const delta = choice?.['delta'] as Record<string, unknown> | undefined;
  const msgObj = choice?.['message'] as Record<string, unknown> | undefined;
  const msgContent = msgObj?.['content'];
  const text = String(delta?.['content'] ?? msgContent ?? '');
  // 推理模型（deepseek-reasoner / *-thinking 等）会把思维链放在
  // reasoning_content 里，content 才是给用户看的答案。流式在 delta 上，
  // 非流式在 message 上，这里都取一下，便于上层判断
  // "内容为空是不是因为预算都被思考吃掉了"。
  const reasoning = String(
    delta?.['reasoning_content'] ??
      delta?.['reasoning'] ??
      msgObj?.['reasoning_content'] ??
      msgObj?.['reasoning'] ??
      '',
  );
  const finish = String(choice?.['finish_reason'] ?? '');
  const usageRaw = json['usage'] as Record<string, unknown> | undefined;
  const usage: LlmUsage | undefined = usageRaw
    ? {
        promptTokens: (usageRaw['prompt_tokens'] as number) ?? 0,
        completionTokens: (usageRaw['completion_tokens'] as number) ?? 0,
        totalTokens:
          (usageRaw['total_tokens'] as number) ??
          ((usageRaw['prompt_tokens'] as number) ?? 0) + ((usageRaw['completion_tokens'] as number) ?? 0),
      }
    : undefined;
  return { text, usage, finish, reasoning };
}

/** 解析 SSE 文本流为事件块 */
async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          const trimmed = line.trimStart();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data) yield data;
        }
      }
    }
    // 处理结尾残余
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 解析 NDJSON 流（Ollama） */
async function* parseNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

export class LlmClient {
  constructor(private readonly log: Logger) {}

  /**
   * 流式对话：返回增量文本的异步迭代器。
   * 同时通过 onDone 回调拿到最终统计。
   */
  async *streamChat(
    messages: ChatMessage[],
    opts: ChatOptions,
  ): AsyncGenerator<string, LlmResult, void> {
    const start = Date.now();
    const root = normalizeBaseUrl(opts.baseURL);
    const adapter = getAdapter(opts.protocol);
    const url = buildUrl(opts.protocol, root, opts.model, true);
    const body = buildRequestBody(opts.protocol, opts.model, messages, opts, true);

    const timeoutMs = opts.timeoutMs ?? 120000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // 外部 signal 也要能中断
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let full = '';
    let reasoningFull = '';
    let usage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason = '';

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...adapter.authHeaders(opts.apiKey),
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new LlmError(
          `模型调用失败 HTTP ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }

      const contentType = res.headers.get('content-type') ?? '';
      const isNdjson = opts.protocol === 'ollama' || contentType.includes('ndjson');
      const events = isNdjson ? parseNdjson(res.body) : parseSse(res.body);

      for await (const raw of events) {
        if (raw === '[DONE]') break;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue; // 心跳等非 JSON 行
        }
        if (json['error']) {
          throw new LlmError(`模型返回错误: ${JSON.stringify(json['error']).slice(0, 300)}`, undefined, true);
        }
        const d = extractDelta(opts.protocol, json);
        if (d.reasoning) reasoningFull += d.reasoning;
        if (d.text) {
          full += d.text;
          yield d.text;
        }
        if (d.usage) {
          usage = {
            promptTokens: Math.max(usage.promptTokens, d.usage.promptTokens),
            completionTokens: Math.max(usage.completionTokens, d.usage.completionTokens),
            totalTokens: Math.max(usage.totalTokens, d.usage.totalTokens),
          };
        }
        if (d.finish) finishReason = d.finish;
      }

      // 流式响应常常不带 usage，用字符数粗估，供成本统计参考
      if (usage.completionTokens === 0 && full.length) {
        usage = { ...usage, completionTokens: Math.ceil(full.length / 1.5) };
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
      }

      return {
        content: full,
        model: opts.model,
        provider: '',
        usage,
        finishReason,
        latencyMs: Date.now() - start,
        ...(reasoningFull ? { reasoning: reasoningFull } : {}),
      };
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // 超时或主动取消：已收到的内容仍然有效
        this.log.warn({ model: opts.model, received: full.length }, '流式请求被中断（超时或取消）');
        return {
          content: full,
          model: opts.model,
          provider: '',
          usage,
          finishReason: 'aborted',
          latencyMs: Date.now() - start,
        };
      }
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 非流式对话（用于内部任务：事实抽取、情绪分析、摘要等） */
  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<LlmResult> {
    const start = Date.now();
    const root = normalizeBaseUrl(opts.baseURL);
    const adapter = getAdapter(opts.protocol);
    const url = buildUrl(opts.protocol, root, opts.model, false);
    const body = buildRequestBody(opts.protocol, opts.model, messages, opts, false);

    const timeoutMs = opts.timeoutMs ?? 120000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...adapter.authHeaders(opts.apiKey),
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new LlmError(
          `模型调用失败 HTTP ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }

      const json = JSON.parse(text) as Record<string, unknown>;
      const d = extractDelta(opts.protocol, json);
      const usage = d.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      return {
        content: d.text,
        model: opts.model,
        provider: '',
        usage,
        finishReason: d.finish,
        latencyMs: Date.now() - start,
        ...(d.reasoning ? { reasoning: d.reasoning } : {}),
      };
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new LlmError(`请求超时(${timeoutMs}ms)`, undefined, true);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}
