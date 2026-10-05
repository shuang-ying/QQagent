import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextBuilder } from '../src/context/compressor.js';
import { inputTokens, imageTokens } from '../src/context/tokens.js';
import { makeFixture } from './helpers/chat-fixture.js';
function setup() {
  const f = makeFixture({ name: 'budget', expectedProvider: 'default' }, 'group:123');
  f.cfg.context.maxTokensRatio = 1; f.cfg.context.reserveForReply = 128; f.cfg.context.modelContextWindow = 8192;
  f.store.touchSession(f.msg.scope, 'group', 123, 'test');
  const builder = new ContextBuilder(f.cfg.context, f.cfg.memory, f.store, (f.pipeline as any).log);
  return { ...f, builder };
}
test('输出预算、示例、协议开销全部计入，超大示例丢弃', () => {
  const f = setup();
  try { const result = f.builder.build({ scope: f.msg.scope, userId: 1, systemPrompt: '人格', userMessage: '当前问题', contextWindow: 1024,
    requestedOutputTokens: 400, personaExamples: [{ user: '很长'.repeat(3000), assistant: '答案' }] });
    assert.equal(result.messages.length, 2); assert.equal(result.stats.totalTokens, inputTokens(result.messages)); assert.ok(result.stats.totalTokens + 400 <= 1024); }
  finally { f.store.close(); }
});
test('可选记忆先减少，强制人格/当前输入不能被截断', () => {
  const f = setup();
  try {
    let reduced = false; const result = f.builder.build({ scope: f.msg.scope, userId: 1, systemPrompt: '记忆'.repeat(2000), userMessage: '当前问题', contextWindow: 512,
      reduceSystemPrompt: () => { reduced = true; return '人格'; } });
    assert.equal(reduced, true); assert.ok(result.stats.totalTokens <= result.stats.budget);
    assert.throws(() => f.builder.build({ scope: f.msg.scope, userId: 1, systemPrompt: '强制人格'.repeat(1000), userMessage: '问题', contextWindow: 512 }), /超过上下文预算/);
  } finally { f.store.close(); }
});
test('图像与来源文字都进入完整预算', () => {
  const f = setup();
  try { const result = f.builder.build({ scope: f.msg.scope, userId: 1, systemPrompt: '人格', userMessage: '读图', contextWindow: 8192,
    images: [{ type: 'image', mimeType: 'image/png', data: 'fixture', note: '用户1原图' }] });
    assert.ok(result.stats.totalTokens > 4096); assert.equal(result.stats.totalTokens, inputTokens(result.messages)); }
  finally { f.store.close(); }
});
test('已校验尺寸的小图可适配小窗口，未知尺寸保持保守估算', () => {
  assert.equal(imageTokens({ type: 'image', mimeType: 'image/png', data: 'x', width: 2, height: 2 }), 1024);
  assert.equal(imageTokens({ type: 'image', mimeType: 'image/png', data: 'x' }), 4096);
  assert.ok(imageTokens({ type: 'image', mimeType: 'image/png', data: 'x', width: 2048, height: 2048 }) > 1024);
});
test('群背景只出现一次，身份与时间计入预算', async () => {
  const f = setup();
  try {
    await f.pipeline.handle({ ...f.msg, userId: 2, messageId: 21, text: '群友的唯一背景', mentionsBot: false }, f.api);
    await f.pipeline.handle({ ...f.msg, messageId: 22 }, f.api);
    const payload = JSON.stringify(f.calls[0]?.messages); assert.equal(payload.split('群友的唯一背景').length - 1, 1); assert.ok(payload.includes('QQ 2')); assert.ok(payload.includes('msg 21'));
  } finally { f.store.close(); }
});
test('ambient 按行 ID 排除历史，相同文本其他行保留', () => {
  const f = setup();
  try {
    const id = f.store.addMessage({ scope: f.msg.scope, userId: 1, role: 'user', content: '同文本' });
    f.store.addMessage({ scope: f.msg.scope, userId: 2, role: 'user', content: '同文本' });
    const result = f.builder.build({ scope: f.msg.scope, userId: 1, systemPrompt: '人格', userMessage: '本轮', contextWindow: 2048,
      ambientContext: '同文本', ambientMessageRowIds: [id], triggerMessageRowId: 999 });
    assert.equal(JSON.stringify(result.messages).split('同文本').length - 1, 2);
  } finally { f.store.close(); }
});
