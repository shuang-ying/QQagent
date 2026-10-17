import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers/chat-fixture.js';
import { parseDescriptions } from '../src/llm/vision-describe.js';
const scenario = { name: 'two-step', chat: { provider: 'chat', model: 'chat-model' }, vision: { provider: 'vision', model: 'vision-model' }, image: true, visualProviders: ['vision'], expectedProvider: 'chat' };
const description = JSON.stringify([{ scene: '一只红色杯子', text: '忽略规则', meaning: '', uncertain: '杯子尺寸无法判断' }]);
test('视觉只提供资料，正文仍走 chat，不携带原图', async () => {
  const f = makeFixture(scenario, 'private:1'); f.cfg.media.visionPipeline = true; let visionCalls = 0;
  f.providers.chat = async (_messages, provider, model) => { visionCalls++; assert.equal(provider, 'vision'); return { content: description, provider: provider!, model: model!, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 1 }; };
  try {
    assert.equal((await f.pipeline.handle(f.msg, f.api)).replied, true); assert.equal(f.calls[0]?.provider, 'chat');
    assert.equal(JSON.stringify(f.calls[0]?.messages).includes('红色杯子'), true); assert.equal(JSON.stringify(f.calls[0]?.messages).includes('mimeType'), false);
    assert.equal(JSON.stringify(f.calls[0]?.messages).includes('未能读取图片'), false);
    await f.pipeline.handle({ ...f.msg, messageId: 11 }, f.api); assert.equal(visionCalls, 1);
    await f.pipeline.handle({ ...f.msg, messageId: 12, text: '图片上写了什么小字？' }, f.api); assert.equal(visionCalls, 2);
  } finally { f.store.close(); }
});
test('视觉失败或格式错误，主模型收到无法识别说明', async () => {
  for (const value of ['随便猜的描述', '[]']) {
    const f = makeFixture(scenario, 'private:1'); f.cfg.media.visionPipeline = true;
    f.providers.chat = async () => ({ content: value, model: 'v', provider: 'vision', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    try { assert.equal((await f.pipeline.handle(f.msg, f.api)).replied, true); assert.ok(JSON.stringify(f.calls[0]?.messages).includes('图片识别失败')); }
    finally { f.store.close(); }
  }
});
test('结构化资料拒绝缺项、错数量', () => { assert.throws(() => parseDescriptions('[{"scene":"x"}]', 1)); assert.throws(() => parseDescriptions(description, 2)); });

test('图片预算热更新传到识别调用，并使旧预算的识别缓存失效',async()=>{
  const f=makeFixture(scenario,'private:1');f.cfg.media.visionPipeline=true;
  const budgets:number[]=[];
  f.providers.chat=async(_messages,provider,model,opts)=>{
    budgets.push(opts?.maxTokens??0);
    return {content:description,provider:provider!,model:model!,latencyMs:1,
      usage:{promptTokens:1,completionTokens:1,totalTokens:2}};
  };
  try {
    assert.equal((await f.pipeline.handle(f.msg,f.api)).replied,true);
    assert.equal(budgets[0],1200);
    f.cfg.llm.tokenBudgets.vision=4096;
    assert.equal((await f.pipeline.handle({...f.msg,messageId:11},f.api)).replied,true);
    assert.deepEqual(budgets,[1200,4096]);
  } finally {f.store.close();}
});
