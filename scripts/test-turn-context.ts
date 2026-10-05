import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeFixture } from './helpers/chat-fixture.js';
import { contentToText, AppConfigSchema } from '../src/core/types.js';
import { ContextBuilder } from '../src/context/compressor.js';
import { MemoryStore } from '../src/memory/store.js';
import pino from 'pino';
const log = pino({ level: 'silent' });
function deferred() { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; }
for (const change of ['switch', 'delete'] as const) {
  await test(`生成中${change}取消正文、发送和落库`, async () => {
    const f = makeFixture({ name: change, expectedProvider: 'default' }, 'private:1');
    const gate = deferred(); const started = deferred(); let signal: AbortSignal | undefined;
    try {
      const original = f.providers.streamChat;
      f.providers.streamChat = async (...args) => { signal = args[4]?.signal; started.release(); await gate.promise; return original(...args); };
      const running = f.pipeline.handle(f.msg, f.api); await started.promise;
      const old = f.store.currentConversationId(f.msg.scope);
      if (change === 'switch') f.store.newConversation(f.msg.scope, 'new'); else f.store.deleteConversation(old);
      assert.equal(signal?.aborted, true); gate.release();
      assert.equal((await running).replied, false); assert.equal(f.sends(), 0);
      assert.equal(f.store.getRecentMessages(f.msg.scope, 20).length, 0);
      assert.equal(f.pipeline.queueStats.pending, 0);
    } finally { f.store.close(); }
  });
}
await test('排队的旧轮次在切换后不再进入模型调用', async () => {
  const f = makeFixture({ name: 'queued', expectedProvider: 'default' }, 'private:1'); const gate = deferred(); const started = deferred();
  try {
    let calls = 0; const original = f.providers.streamChat;
    f.providers.streamChat = async (...args) => { calls++; started.release(); await gate.promise; return original(...args); };
    const first = f.pipeline.handle(f.msg, f.api); const second = f.pipeline.handle({ ...f.msg, messageId: 11 }, f.api);
    await started.promise; f.store.newConversation(f.msg.scope); gate.release();
    const results = await Promise.all([first, second]); assert.equal(results.filter(r => r.replied).length, 0); assert.equal(calls, 1);
  } finally { f.store.close(); }
});
await test('分片中切换只保留已发送片段在旧话题', async () => {
  const f = makeFixture({ name: 'send', expectedProvider: 'default' }, 'private:1'); let old = ''; let next = ''; let sends = 0;
  try {
    f.providers.streamChat = async () => ({ content: '甲'.repeat(1200), model: 'test', provider: 'test', latencyMs: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    f.api.sendToScope = async () => { sends++; old = f.store.currentConversationId(f.msg.scope); next = f.store.newConversation(f.msg.scope); return { message_id: 55 }; };
    const result = await f.pipeline.handle(f.msg, f.api);
    assert.equal(sends, 1); assert.equal(result.deliveryState, 'partial');
    assert.equal(f.store.getConversationMessages(old).filter(m => m.role === 'assistant').length, 1);
    assert.equal(f.store.getConversationMessages(next).length, 0);
    const delivery = f.store.db.prepare('SELECT conversation_id FROM reply_deliveries').get() as { conversation_id: string };
    assert.equal(delivery.conversation_id, old);
  } finally { f.store.close(); }
});
await test('生成开始前新消息进入窗口，当前消息按 ID 注入一次', async () => {
  const f = makeFixture({ name: 'boundary', expectedProvider: 'default' }, 'private:1');
  try {
    await Promise.all([f.pipeline.handle({ ...f.msg, text: '前一条' }, f.api),
      f.pipeline.handle({ ...f.msg, messageId: 11, text: '后一条独有内容' }, f.api)]);
    const firstPrompt = f.calls[0]!.messages.filter(m => m.role !== 'system').map(m => contentToText(m.content)).join('\n');
    assert.equal(firstPrompt.includes('后一条独有内容'), true);
    assert.equal(firstPrompt.split('前一条').length - 1, 1);
  } finally { f.store.close(); }
});
await test('在途角色配置保持快照，下一轮使用新配置', async () => {
  const f = makeFixture({ name: 'snapshot', expectedProvider: 'default' }, 'private:1');
  try {
    const first = f.pipeline.handle(f.msg, f.api);
    f.cfg.llm.roles.chat.provider = 'new-provider'; f.cfg.llm.roles.chat.model = 'new-model';
    await first;
    await f.pipeline.handle({ ...f.msg, messageId: 11 }, f.api);
    assert.deepEqual(f.calls.map(c => c.provider), ['default', 'new-provider']);
    const versions = f.logs.filter(l => l.msg === '上下文已构建').map(l => l.configVersion);
    assert.notEqual(versions[0], versions[1]);
  } finally { f.store.close(); }
});
await test('同文本历史不会按 includes 误删本轮输入', () => {
  const store = new MemoryStore(':memory:');
  try {
    store.touchSession('private:1', 'private', 1, 'test'); const conversationId = store.currentConversationId('private:1');
    store.addMessage({ scope: 'private:1', userId: 1, role: 'user', content: '更长的你好内容' });
    const rowId = store.addMessage({ scope: 'private:1', userId: 1, role: 'user', content: '你好' });
    const cfg = AppConfigSchema.parse({});
    const result = new ContextBuilder(cfg.context, cfg.memory, store, log).build({ scope: 'private:1', userId: 1,
      systemPrompt: 'rule', userMessage: '你好', contextWindow: 32768, conversationId, historyCutoffId: rowId, triggerMessageRowId: rowId });
    assert.equal(contentToText(result.messages.at(-1)!.content), '你好');
    assert.ok(result.messages.some(m => contentToText(m.content).includes('更长的你好内容')));
  } finally { store.close(); }
});
for (const deleted of [false, true]) {
  await test(`摘要生成后话题${deleted ? '删除不复活' : '切换仍归原话题'}`, async () => {
    const store = new MemoryStore(':memory:'); const gate = deferred(); const started = deferred();
    try {
      store.touchSession('private:1', 'private', 1, 'test'); const old = store.currentConversationId('private:1');
      for (let i = 0; i < 8; i++) store.addMessage({ scope: 'private:1', userId: 1, role: 'user', content: `原消息${i}` });
      const cfg = AppConfigSchema.parse({ memory: { summary: { keepRecentTurns: 1 } } });
      const builder = new ContextBuilder(cfg.context, cfg.memory, store, log);
      const pending = builder.compress('private:1', async () => { started.release(); await gate.promise; return '原话题摘要'; }, old);
      await started.promise; const next = store.newConversation('private:1'); if (deleted) store.deleteConversation(old);
      gate.release(); const result = await pending;
      assert.equal(result.ok, !deleted); assert.equal(store.getSummaries('private:1', undefined, 20, next).length, 0);
      if (!deleted) assert.equal(store.getSummaries('private:1', undefined, 20, old).length, 1);
    } finally { store.close(); }
  });
}

await test('切换话题立即取消思考延迟，不占用旧队列', async () => {
  const f = makeFixture({ name: 'delay', expectedProvider: 'default' }, 'private:1');
  try {
    f.cfg.reply.typingDelayMs = [60000, 60000];
    const pending = f.pipeline.handle(f.msg, f.api);
    await new Promise(r => setTimeout(r, 5)); f.store.newConversation(f.msg.scope);
    const result = await pending;
    assert.equal(result.replied, false); assert.equal(f.calls.length, 0); assert.equal(f.pipeline.queueStats.pending, 0);
  } finally { f.store.close(); }
});
