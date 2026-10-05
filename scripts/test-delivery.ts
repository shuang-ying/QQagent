import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { ReplyBehaviorSchema } from '../src/core/types.js';
import { ReplyDispatcher } from '../src/pipeline/dispatch.js';
import { OneBotActionError } from '../src/onebot/action.js';
import type { OneBotAction } from '../src/onebot/action.js';
import { makeFixture } from './helpers/chat-fixture.js';
import { OneBotAction as Action } from '../src/onebot/action.js';
const log = pino({ level: 'silent' });
const ctx = { scope: 'group:123', scopeType: 'group' as const, userId: 1, messageId: 10 };
await test('结果未知不退化重发', async () => {
  let calls = 0;
  const api = { sendToScope: async () => { calls++; throw new OneBotActionError('send_group_msg', 'failed', -1, 'timeout', 'unknown'); } } as unknown as OneBotAction;
  const r = await new ReplyDispatcher(ReplyBehaviorSchema.parse({ quoteOnReply: true }), log).send(api, ctx, 'hi');
  assert.equal(calls, 1); assert.equal(r.state, 'unknown'); assert.equal(r.sent, 0);
});
await test('明确拒绝头部才退化，保留成功 QQ 消息 ID', async () => {
  let calls = 0;
  const api = { sendToScope: async () => { if (++calls === 1) throw new OneBotActionError('send', 'failed', 1400, 'invalid reply'); return { message_id: 55 }; } } as unknown as OneBotAction;
  const r = await new ReplyDispatcher(ReplyBehaviorSchema.parse({ quoteOnReply: true }), log).send(api, ctx, 'hi');
  assert.equal(calls, 2); assert.equal(r.state, 'success'); assert.equal(r.pieces[0]!.messageId, 55);
});
for (const outcome of ['failed', 'unknown'] as const) {
  await test(`管线全部投递${outcome}不写入助手历史`, async () => {
    const f = makeFixture({ name: 'delivery', expectedProvider: 'default' }, 'private:1');
    try {
      f.api.sendToScope = async () => { throw new OneBotActionError('send', 'failed', -1, 'error', outcome); };
      const r = await f.pipeline.handle(f.msg, f.api);
      assert.equal(r.replied, false); assert.equal(r.deliveryState, outcome);
      assert.equal(f.store.getRecentMessages(f.msg.scope, 20).filter(m => m.role === 'assistant').length, 0);
      assert.equal((f.store.db.prepare('SELECT state FROM reply_deliveries').get() as { state: string }).state, outcome);
    } finally { f.store.close(); }
  });
}
await test('长回复部分成功只保存已送片段和 ID，停止后续片段', async () => {
  const f = makeFixture({ name: 'partial', expectedProvider: 'default' }, 'private:1');
  let calls = 0;
  try {
    f.providers.streamChat = async () => ({ content: '甲'.repeat(1200), model: 'test', provider: 'test',
      latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    f.api.sendToScope = async () => { if (++calls === 1) return { message_id: 99 }; throw new OneBotActionError('send', 'failed', 1400, 'rejected'); };
    const r = await f.pipeline.handle(f.msg, f.api);
    const rows = f.store.getRecentMessages(f.msg.scope, 20).filter(m => m.role === 'assistant');
    assert.equal(r.replied, true); assert.equal(r.deliveryState, 'partial'); assert.equal(calls, 2);
    assert.equal(rows.length, 1); assert.equal(rows[0]!.message_id, 99); assert.equal(rows[0]!.content.length, 500);
    assert.equal(r.content!.length, 500);
  } finally { f.store.close(); }
});

await test('OneBot async 受理状态是结果未知，不能退化重发', async () => {
  let calls = 0;
  const api = new Action(() => { calls++; return true; }, async () => ({ status: 'async', retcode: 1, data: null }), log);
  const r = await new ReplyDispatcher(ReplyBehaviorSchema.parse({}), log).send(api, ctx, 'hi');
  assert.equal(r.state, 'unknown'); assert.equal(calls, 1);
});

await test('成功响应缺少 QQ 消息 ID 时不盲目重发', async () => {
  let calls = 0;
  const api = { sendToScope: async () => { calls++; return {}; } } as unknown as OneBotAction;
  const r = await new ReplyDispatcher(ReplyBehaviorSchema.parse({}), log).send(api, ctx, 'hi');
  assert.equal(r.state, 'unknown'); assert.equal(calls, 1);
});
