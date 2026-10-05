import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auxiliary, modulatedEmotion } from '../src/pipeline/auxiliary.js';
import { makeFixture } from './helpers/chat-fixture.js';
test('辅助超时真正取消，晚到结果不替换降级', async () => {
  let aborted = false;
  const result = await auxiliary(signal => new Promise<string>(r => signal.addEventListener('abort', () => { aborted = true; setTimeout(() => r('late'), 10); })), () => 'rule', 15);
  assert.equal(result, 'rule'); assert.equal(aborted, true);
});
test('取消与失败都可降级', async () => {
  const ctrl = new AbortController(); ctrl.abort();
  assert.equal(await auxiliary(async () => 1, () => 2, 10, ctrl.signal), 2);
  assert.equal(await auxiliary(async () => { throw new Error('bad'); }, () => 3, 10), 3);
});
test('低置信度单次异常情绪受 EMA 约束', () => {
  const mixed = modulatedEmotion({ label: 'anger', intensity: 1, valence: -1, arousal: 1, confidence: 0.4 }, { intensity: 0.2, valence: 0, arousal: 0.2 });
  assert.ok(mixed.intensity < 0.5); assert.ok(mixed.valence > -0.5);
});
test('管线同时启动情绪和检索，失败仍能回复', async () => {
  const f = makeFixture({ name: 'parallel', expectedProvider: 'default' }, 'private:1');
  try {
    f.cfg.emotion.enabled = true; f.cfg.emotion.mode = 'llm'; f.cfg.emotion.timeoutMs = 20; f.cfg.memory.retrieval.timeoutMs = 20;
    let retrievalStarted = false;
    const retriever = (f.pipeline as any).retriever; retriever.retrieveMerged = async () => { retrievalStarted = true; return new Promise(() => {}); };
    retriever.retrieve = () => ({ facts: ['关键词降级事实'], summaries: [], hitIds: [] });
    const emotion = (f.pipeline as any).emotion; emotion.snapshot = () => ({ analyze: async () => { assert.equal(retrievalStarted, true); throw new Error('synthetic'); } });
    assert.equal((await f.pipeline.handle(f.msg, f.api)).replied, true);
    assert.ok(JSON.stringify(f.calls[0]?.messages).includes('关键词降级事实'));
  } finally { f.store.close(); }
});
