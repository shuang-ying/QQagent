import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { AppConfigSchema, ProviderSchema } from '../src/core/types.js';
import { ProviderManager } from '../src/llm/manager.js';
import { LlmError } from '../src/llm/client.js';
import { setModelOverrides } from '../src/llm/protocol.js';
import { fitModelBudget } from '../src/llm/budget.js';
const log = pino({ level: 'silent' });
function fixture() {
  const mgr = Object.create(ProviderManager.prototype) as ProviderManager;
  const configs = { a: ProviderSchema.parse({ baseURL: 'https://mock.invalid', protocol: 'openai', models: [{ id: 'main', contextWindow: 4000 }] }),
    b: ProviderSchema.parse({ baseURL: 'https://mock.invalid', protocol: 'openai', models: [{ id: 'backup', contextWindow: 1000, supportsVision: false }] }) };
  const calls: Array<{ model: string; messages: unknown[]; max: number }> = [];
  Object.assign(mgr, { providers: configs, llmCfg: AppConfigSchema.parse({ llm: { request: { maxRetries: 0 } } }).llm,
    log, cache: { version: 1, entries: {} }, defaultContextWindow: 32768, usage: new Map(), saveCache: () => {},
    client: { chat: async (messages: unknown[], opts: { model: string; maxTokens: number }) => {
      calls.push({ model: opts.model, messages, max: opts.maxTokens });
      if (opts.model === 'main') throw new LlmError('primary failed', 503, true);
      return { content: 'ok', model: opts.model, provider: '', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    } },
  });
  return { mgr, configs, calls };
}
await test('旧 fallback 字符串选择备用供应商自身模型', async () => {
  const { mgr, calls } = fixture();
  const r = await mgr.chat([{ role: 'user', content: 'hi' }], 'a', 'main', {}, ['b']);
  assert.equal(r.model, 'backup'); assert.deepEqual(calls.map(c => c.model), ['main', 'backup']);
});
await test('显式模型组合和较小窗口重新裁剪预算', async () => {
  const { mgr, calls } = fixture();
  await mgr.chat([{ role: 'system', content: 'rule' }, { role: 'user', content: '旧'.repeat(2000) },
    { role: 'user', content: 'new' }], 'a', 'main', { maxTokens: 800 }, [{ provider: 'b', model: 'backup' }]);
  assert.equal(calls[1]!.max, 500); assert.equal(calls[1]!.messages.length, 2);
});
await test('含图片时拒绝非视觉候选', async () => {
  const { mgr, calls } = fixture();
  await assert.rejects(mgr.chat([{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'test' }] }],
    'a', 'main', {}, ['b']), /不支持图片/);
  assert.equal(calls.length, 0);
});
await test('人工覆盖优先，服务能力高于名字启发', async () => {
  const { mgr, configs } = fixture();
  configs.b.models = [{ id: 'gpt-4o', name: '', tags: [], supportsVision: false, contextWindow: 900 }];
  mgr.resolveRole = () => ({ provider: 'b', model: 'gpt-4o' });
  assert.equal((await mgr.resolveModel('b')).supportsVision, false);
  assert.equal(mgr.visionHealth().ok, false);
  setModelOverrides({ 'gpt-4o': { vision: true, contextWindow: 1500 } });
  try { const r = await mgr.resolveModel('b'); assert.equal(r.supportsVision, true); assert.equal(r.contextWindow, 1500); assert.equal(mgr.visionHealth().ok, true); }
  finally { setModelOverrides({}); }
});
await test('供应商更新删除旧缓存', async () => {
  const { mgr, configs } = fixture();
  const state = mgr as unknown as { cache: { entries: Record<string, unknown> } };
  state.cache.entries.b = { models: [{ id: 'old' }] };
  mgr.addProvider('b', { ...configs.b, baseURL: 'https://changed.invalid' });
  assert.equal(state.cache.entries.b, undefined);
  assert.equal(mgr.getProvider('b')!.baseURL, 'https://changed.invalid');
});
await test('禁用供应商不得调用', async () => {
  const { mgr, configs } = fixture(); configs.a.enabled = false;
  await assert.rejects(mgr.resolveModel('a'), /禁用/);
});
await test('系统和当前输入无法适配窗口时明确失败', () => {
  assert.throws(() => fitModelBudget([{ role: 'system', content: '长'.repeat(5000) }, { role: 'user', content: 'hi' }], 100, 40), /上下文预算/);
});
await test('新旧 fallback 配置都通过 Schema', () => {
  const cfg = AppConfigSchema.parse({ llm: { fallback: ['b', { provider: 'c', model: 'other' }] } });
  assert.deepEqual(cfg.llm.fallback, ['b', { provider: 'c', model: 'other' }]);
});

await test('缓存保留服务能力，不被名称重新推断覆盖', async () => {
  const { mgr, configs } = fixture(); configs.b.models = [];
  const internal = mgr as unknown as { fingerprint: (p: unknown) => string; cache: { entries: Record<string, unknown> } };
  internal.cache.entries.b = { protocol: 'openai', models: [{ id: 'custom', name: 'custom', supportsVision: true,
    supportsStream: false, contextWindow: 900, tags: [] }], discoveredAt: 0, fingerprint: internal.fingerprint(configs.b) };
  const r = await mgr.resolveModel('b', 'custom');
  assert.equal(r.supportsVision, true); assert.equal(r.supportsStream, false); assert.equal(r.contextWindow, 900);
});

await test('配置更新期间返回的发现结果不得覆盖新缓存', async () => {
  const { mgr, configs } = fixture(); configs.a.models = [];
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(r => release = r); const ready = new Promise<void>(r => started = r);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { started(); await gate; return new Response(JSON.stringify({ data: [{ id: 'old' }] })); };
  try {
    const pending = mgr.ensureModels('a'); const rejected = assert.rejects(pending, /过时发现/);
    await ready; mgr.addProvider('a', { ...configs.a, baseURL: 'https://new.invalid' }); release(); await rejected;
    assert.equal((mgr as unknown as { cache: { entries: Record<string, unknown> } }).cache.entries.a, undefined);
  } finally { globalThis.fetch = original; }
});
