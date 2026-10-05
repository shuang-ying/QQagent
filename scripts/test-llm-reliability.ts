import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { AppConfigSchema } from '../src/core/types.js';
import { LlmClient, LlmError } from '../src/llm/client.js';
import { ProviderManager } from '../src/llm/manager.js';

const log = pino({ level: 'silent' });
const messages = [{ role: 'user' as const, content: 'hello' }];
const opts = { baseURL: 'https://mock.invalid/v1', apiKey: '', model: 'test', protocol: 'openai' as const };
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
const event = (text: string, finish: string | null = null) => ({ choices: [{ delta: { content: text }, finish_reason: finish }] });
function manager(config: unknown = {}) {
  const cfg = AppConfigSchema.parse({ llm: { request: { maxRetries: 1, retryDelayMs: 0 }, ...config as object } });
  const mgr = Object.create(ProviderManager.prototype) as ProviderManager;
  Object.assign(mgr, { llmCfg: cfg.llm, log, client: new LlmClient(log), usage: new Map(), providers: {
    p: { ...opts, headers: {}, enabled: true, models: [] },
  } });
  mgr.resolveModel = async () => ({ providerKey: 'p', providerName: 'p', modelId: 'test', modelName: 'test',
    protocol: 'openai', contextWindow: 32768, supportsStream: true, supportsVision: false });
  return mgr;
}
async function mock(run: () => Promise<void>, fetcher: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { await run(); } finally { globalThis.fetch = original; }
}
async function stream(_text: string) {
  const gen = new LlmClient(log).streamChat(messages, opts);
  let result;
  while (true) { const next = await gen.next(); if (next.done) { result = next.value; break; } }
  return result;
}

await test('SSE CRLF、多行 data 和拆开的 UTF-8 字符', async () => {
  const raw = `: heartbeat\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"你好"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const bytes = new TextEncoder().encode(raw);
  await mock(async () => assert.equal((await stream(raw)).content, '你好'), async () => new Response(new ReadableStream({
    start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); },
  })));
});
await test('断流抛错，部分正文不计成功', async () => {
  await mock(async () => assert.rejects(stream(''), /结束标记/), async () => new Response(`data: ${JSON.stringify(event('半句'))}\n\n`));
});
await test('Anthropic SSE 合计输入与输出用量', async () => {
  const events = [{ type: 'message_start', message: { usage: { input_tokens: 8 } } },
    { type: 'content_block_delta', delta: { text: 'ok' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }];
  await mock(async () => {
    const gen = new LlmClient(log).streamChat(messages, { ...opts, protocol: 'anthropic' });
    while (true) { const n = await gen.next(); if (n.done) { assert.equal(n.value.usage.totalTokens, 11); break; } }
  }, async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')));
});
await test('非流式配置真正生效，429 重试一次', async () => {
  let calls = 0;
  await mock(async () => {
    const result = await manager({ generation: { stream: false, temperature: 0.3, maxTokens: 64 } }).streamChat(messages, 'p', undefined, () => {});
    assert.equal(result.content, 'ok'); assert.equal(calls, 2);
  }, async (_, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, false); assert.equal(body.temperature, 0.3); assert.equal(body.max_tokens, 64);
    return calls === 1 ? new Response('busy', { status: 429 }) : ok();
  });
});
await test('401 不重试', async () => {
  let calls = 0;
  await mock(async () => { await assert.rejects(manager().chat(messages, 'p', undefined), /401/); assert.equal(calls, 1); },
    async () => { calls++; return new Response('no', { status: 401 }); });
});
await test('预取消不发请求且不回退', async () => {
  await mock(async () => assert.rejects(manager().chat(messages, 'p', undefined, { signal: AbortSignal.abort() }, ['other']),
    (e: unknown) => e instanceof LlmError && e.cancelled), async () => { throw new Error('不应 fetch'); });
});
await test('重试等待期间取消', async () => {
  const ctrl = new AbortController(); let calls = 0;
  await mock(async () => {
    const promise = manager().chat(messages, 'p', undefined, { signal: ctrl.signal, retryDelayMs: 100 });
    setTimeout(() => ctrl.abort(), 10);
    await assert.rejects(promise, /取消/); assert.equal(calls, 1);
  }, async () => { calls++; return new Response('busy', { status: 503 }); });
});
await test('重试遵循总预算，不扩展到下一次尝试', async () => {
  let calls = 0;
  await mock(async () => {
    await assert.rejects(manager().chat(messages, 'p', undefined, { timeoutMs: 20, retryDelayMs: 30 }), /总时间预算/);
    assert.equal(calls, 1);
  }, async () => { calls++; return new Response('busy', { status: 503 }); });
});
await test('流式超时丢弃正文，不重试到新的预算', async () => {
  let calls = 0;
  await mock(async () => {
    await assert.rejects(manager().streamChat(messages, 'p', undefined, () => {}, { timeoutMs: 15 }), /超时|预算/);
    assert.equal(calls, 1);
  }, async (_, init) => { calls++; return new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event('half'))}\n\n`));
    init!.signal!.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')), { once: true });
  } })); });
});
await test('断流重试只发布完整成功正文', async () => {
  let calls = 0; const chunks: string[] = [];
  await mock(async () => {
    const result = await manager().streamChat(messages, 'p', undefined, t => chunks.push(t));
    assert.equal(result.content, 'complete'); assert.deepEqual(chunks, ['complete']); assert.equal(calls, 2);
  }, async () => { calls++; return new Response(`data: ${JSON.stringify(event(calls === 1 ? 'half' : 'complete', calls === 1 ? null : 'stop'))}\n\n`); });
});

await test('模型解析挂起也受总预算约束', async () => {
  const mgr = manager(); mgr.resolveModel = () => new Promise(() => {});
  await mock(async () => assert.rejects(mgr.chat(messages, 'p', undefined, { timeoutMs: 10 }), /总时间预算/),
    async () => { throw new Error('不应进入调用'); });
});

await test('非流式正文读取超过预算也拒绝成功', async () => {
  await mock(async () => assert.rejects(new LlmClient(log).chat(messages, { ...opts, timeoutMs: 5 }), /超时/), async () => {
    await new Promise(r => setTimeout(r, 15)); return ok();
  });
});

await test('Gemini 文本和 usage 同事件时保留统计和结束状态', async () => {
  const payload = { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 10 } };
  await mock(async () => {
    const gen = new LlmClient(log).streamChat(messages, { ...opts, protocol: 'gemini' });
    while (true) { const next = await gen.next(); if (next.done) {
      assert.equal(next.value.content, 'ok'); assert.deepEqual(next.value.usage, { promptTokens: 5, completionTokens: 5, totalTokens: 10 }); break;
    } }
  }, async () => new Response(`data: ${JSON.stringify(payload)}\n\n`));
});

await test('流内鉴权错误不当作临时错误重试', async () => {
  let calls = 0;
  await mock(async () => {
    await assert.rejects(manager().streamChat(messages, 'p', undefined, () => {}), /invalid_api_key/);
    assert.equal(calls, 1);
  }, async () => { calls++; return new Response('data: {"error":{"code":"invalid_api_key","message":"invalid key"}}\n\n'); });
});
