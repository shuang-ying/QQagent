/** 协议回归：全部 fetch 被替换，不读取配置、不连接服务、不写数据库。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { LlmClient } from '../src/llm/client.js';
import type { ChatOptions } from '../src/llm/client.js';
import { embedTexts } from '../src/llm/embedding.js';
import type { ChatMessage, LlmResult } from '../src/core/types.js';

const client = new LlmClient(pino({ level: 'silent' }));
const messages: ChatMessage[] = [{ role: 'user', content: '你好' }];
const base = { baseURL: 'https://mock.invalid', apiKey: 'test-key', model: 'test-model' };
type Captured = { url: string; body: Record<string, unknown>; headers: Headers };

async function withFetch<T>(response: Response, run: (calls: Captured[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new URL(url).hostname, 'mock.invalid');
    assert.equal(init?.method, 'POST');
    calls.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return response;
  };
  try {
    const result = await run(calls);
    assert.equal(calls.length, 1, '每个场景只调用一次桩');
    return result;
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
});

async function collect(opts: ChatOptions, input = messages): Promise<{ chunks: string[]; result: LlmResult }> {
  const iterator = client.streamChat(input, opts);
  const chunks: string[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return { chunks, result: next.value };
    chunks.push(next.value);
  }
}

// 顶层逐个 await，避免全局 fetch 桩相互覆盖。
for (const stream of [false, true]) {
  await test(`Ollama ${stream ? '流式' : '非流式'}携带模型、参数与图片`, async () => {
    const payload = { message: { content: '你好' }, done: true, prompt_eval_count: 7, eval_count: 3 };
    const response = stream
      ? new Response(JSON.stringify(payload) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
      : jsonResponse(payload);
    await withFetch(response, async (calls) => {
      const opts: ChatOptions = { ...base, baseURL: base.baseURL + '/v1', protocol: 'ollama', temperature: 0, maxTokens: 32 };
      const input: ChatMessage[] = [{ role: 'user', content: [
        { type: 'text', text: '你好' }, { type: 'image', mimeType: 'image/png', data: 'aW1n' },
      ] }];
      let result: LlmResult;
      if (stream) {
        const collected = await collect(opts, input);
        assert.deepEqual(collected.chunks, ['你好']);
        result = collected.result;
      } else {
        result = await client.chat(input, opts);
      }
      assert.deepEqual(calls[0]!.body.messages, [{ role: 'user', content: '你好[图片]', images: ['aW1n'] }]);
      assert.equal(calls[0]!.url, base.baseURL + '/api/chat');
      assert.equal(calls[0]!.body.model, base.model);
      assert.equal(calls[0]!.body.stream, stream);
      assert.deepEqual(calls[0]!.body.options, { temperature: 0, num_predict: 32 });
      assert.equal(result.content, '你好');
      assert.deepEqual(result.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    });
  });
}

await test('Anthropic 非流式拼接文本，忽略思考/工具块并保留用量和停止原因', async () => {
  await withFetch(jsonResponse({ type: 'message', content: [
    { type: 'thinking', thinking: '内部思考' }, { type: 'text', text: '你好' },
    { type: 'tool_use', id: 't1', input: {} }, { type: 'text', text: '！' },
  ], usage: { input_tokens: 12, output_tokens: 4 }, stop_reason: 'end_turn' }), async (calls) => {
    const result = await client.chat([{ role: 'system', content: '规则' }, ...messages], {
      ...base, protocol: 'anthropic', maxTokens: 64,
    });
    assert.equal(result.content, '你好！');
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    assert.equal(result.finishReason, 'end_turn');
    assert.equal(calls[0]!.url, base.baseURL + '/v1/messages');
    assert.equal(calls[0]!.headers.get('x-api-key'), 'test-key');
    assert.equal(calls[0]!.body.system, '规则');
    assert.equal(calls[0]!.body.max_tokens, 64);
  });
});

await test('Anthropic 只有工具块时不把工具内容当作回复', async () => {
  await withFetch(jsonResponse({ type: 'message', content: [{ type: 'tool_use', input: { secret: '工具参数' } }],
    stop_reason: 'tool_use' }), async () => {
    const result = await client.chat(messages, { ...base, protocol: 'anthropic' });
    assert.equal(result.content, '');
    assert.equal(result.finishReason, 'tool_use');
    assert.deepEqual(result.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });
});

await test('Anthropic 现有 SSE 文本增量仍可读取', async () => {
  const events = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  await withFetch(new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), async () => {
    const { chunks, result } = await collect({ ...base, protocol: 'anthropic' });
    assert.deepEqual(chunks, ['你好']);
    assert.equal(result.content, '你好');
    assert.equal(result.finishReason, 'end_turn');
  });
});

for (const root of [base.baseURL, base.baseURL + '/v1beta/']) {
  for (const model of ['embed-model', 'models/embed-model']) {
    await test(`Gemini 批量向量：根路径 ${root}，模型 ${model}`, async () => {
      await withFetch(jsonResponse({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }), async (calls) => {
        const result = await embedTexts({ ...base, baseURL: root, model, protocol: 'gemini', texts: ['甲', '乙'] });
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(result.vectors, [[1, 2], [3, 4]]);
        assert.equal(calls[0]!.url, base.baseURL + '/v1beta/models/embed-model:batchEmbedContents');
        assert.equal(calls[0]!.headers.get('x-goog-api-key'), 'test-key');
        assert.deepEqual(calls[0]!.body, { requests: ['甲', '乙'].map((text) => ({
          model: 'models/embed-model', content: { parts: [{ text }] },
        })) });
      });
    });
  }
}

for (const [name, response, error] of [
  ['数量不匹配', jsonResponse({ embeddings: [{ values: [1, 2] }] }), /数量\(1\).*请求\(2\)/],
  ['缺少 values', jsonResponse({ embeddings: [{ other: [] }, null] }), /数量\(0\)/],
  ['非法 JSON', new Response('invalid'), /合法 JSON/],
  ['鉴权失败', new Response('denied', { status: 403 }), /鉴权失败/],
] as const) {
  await test(`Gemini 失败响应：${name}`, async () => {
    await withFetch(response, async () => {
      const result = await embedTexts({ ...base, protocol: 'gemini', texts: ['甲', '乙'] });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', error);
    });
  });
}

for (const [protocol, payload, endpoint] of [
  ['openai', { data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }, '/embeddings'],
  ['ollama', { embeddings: [[1, 2], [3, 4]] }, '/api/embed'],
] as const) {
  await test(`${protocol} 批量向量回归`, async () => {
    await withFetch(jsonResponse(payload), async (calls) => {
      const result = await embedTexts({ ...base, protocol, texts: ['甲', '乙'] });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.vectors, [[1, 2], [3, 4]]);
      assert.equal(calls[0]!.url, base.baseURL + endpoint);
      assert.deepEqual(calls[0]!.body, { model: base.model, input: ['甲', '乙'] });
    });
  });
}

await test('Ollama 单向量旧响应回归', async () => {
  await withFetch(jsonResponse({ embedding: [1, 2] }), async () => {
    const result = await embedTexts({ ...base, protocol: 'ollama', texts: ['甲'] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.vectors, [[1, 2]]);
  });
});

await test('OpenAI 非流式对话回归', async () => {
  await withFetch(jsonResponse({ choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), async (calls) => {
    const result = await client.chat(messages, { ...base, protocol: 'openai' });
    assert.equal(result.content, '你好');
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    assert.equal(calls[0]!.body.model, base.model);
    assert.equal(calls[0]!.headers.get('authorization'), 'Bearer test-key');
  });
});
