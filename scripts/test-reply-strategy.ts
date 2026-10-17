import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionScheduler } from '../src/pipeline/scheduler.js';
import { makeFixture } from './helpers/chat-fixture.js';
import { contentToText } from '../src/core/types.js';
test('直接提问先于排队的主动任务', async () => {
  const q = new SessionScheduler({ maxPendingPerScope: 8, maxPendingTotal: 20, maxActiveScopes: 1 });
  let release!: () => void; const order: string[] = [];
  const running = q.enqueue('s', () => new Promise<void>(r => release = r));
  const low = q.enqueue('s', async () => { order.push('proactive'); }, 2);
  const high = q.enqueue('s', async () => { order.push('direct'); }, 0);
  await new Promise(r => setTimeout(r, 1)); release(); await Promise.all([running, low, high]);
  assert.deepEqual(order, ['direct', 'proactive']);
});
test('短消息合并一次，原文留档、输入不重复', async () => {
  const f = makeFixture({ name: 'merge', expectedProvider: 'default' }, 'private:1'); f.cfg.scheduling.shortMessageMergeMs = 20;
  try {
    const results = await Promise.all(['第一段', '补充条件', '最后问题'].map((text, i) => f.pipeline.handle({ ...f.msg, text, messageId: 20 + i }, f.api)));
    assert.equal(results.filter(r => r.replied).length, 1); assert.equal(f.calls.length, 1);
    const input = f.calls[0]!.messages.map(m => contentToText(m.content)).join('\n');
    for (const text of ['第一段', '补充条件', '最后问题']) assert.equal(input.split(text).length - 1, 1);
    assert.equal(f.store.getRecentMessages(f.msg.scope, 20).filter(m => m.role === 'user').length, 3);
  } finally { f.store.close(); }
});
test('合并等待中切换话题取消，不归入新话题', async () => {
  const f = makeFixture({ name: 'merge-cancel', expectedProvider: 'default' }, 'private:1'); f.cfg.scheduling.shortMessageMergeMs = 40;
  try { const task = f.pipeline.handle(f.msg, f.api); f.store.newConversation(f.msg.scope, 'new'); assert.equal((await task).replied, false); assert.equal(f.calls.length, 0); }
  finally { f.store.close(); }
});
test('冷却中引用机器人触发，引用别人不触发', async () => {
  const f = makeFixture({ name: 'quote', expectedProvider: 'default' }, 'group:123'); f.cfg.trigger.group.cooldownMs = 100000;
  try {
    await f.pipeline.handle(f.msg, f.api);
    const quote = { ...f.msg, messageId: 21, mentionsBot: false, segments: [{ type: 'reply', data: { id: 1 } }] };
    assert.equal((await f.pipeline.handle(quote, f.api)).replied, true);
    assert.equal((await f.pipeline.handle({ ...quote, messageId: 22, segments: [{ type: 'reply', data: { id: 99999 } }] }, f.api)).replied, false);
  } finally { f.store.close(); }
});
test('新群消息取消生成中的主动任务，不发送旧回复', async () => {
  const f = makeFixture({ name: 'obsolete', expectedProvider: 'default' }, 'group:123');
  try {
    f.cfg.proactive.enabled = true; f.cfg.proactive.mode = 'probability'; f.cfg.proactive.quietHours = [];
    f.cfg.proactive.minGapAfterBotMs = 0; f.cfg.proactive.minIntervalMs = 0;
    await f.pipeline.handle({ ...f.msg, mentionsBot: false }, f.api);
    let started!: () => void; const ready = new Promise<void>(r => started = r);
    f.providers.streamChat = async (_messages, _p, _m, _delta, opts) => {
      started(); await new Promise<void>(r => opts?.signal?.addEventListener('abort', () => r()));
      throw new Error('cancelled');
    };
    const old = f.pipeline.handleProactive(f.msg.scope, 'group', 123, 'test', f.api); await ready;
    await f.pipeline.handle({ ...f.msg, messageId: 22, text: '已经换了话题', mentionsBot: false }, f.api);
    assert.equal((await old).replied, false); assert.equal(f.sends(), 0);
  } finally { f.store.close(); }
});
