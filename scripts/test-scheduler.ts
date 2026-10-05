import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionScheduler } from '../src/pipeline/scheduler.js';
import { makeFixture } from './helpers/chat-fixture.js';
const limits = { maxPendingPerScope: 3, maxPendingTotal: 5, maxActiveScopes: 2 };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; };
await test('同会话顺序，多会话并行，结束完全清理', async () => {
  const q = new SessionScheduler(limits); const gate = deferred(); const order: string[] = [];
  const a = q.enqueue('a', async () => { order.push('a1'); await gate.promise; });
  const b = q.enqueue('a', async () => { order.push('a2'); });
  const c = q.enqueue('b', async () => { order.push('b1'); });
  await c; assert.deepEqual(order, ['a1', 'b1']); gate.release(); await Promise.all([a, b]);
  assert.deepEqual(order, ['a1', 'b1', 'a2']); assert.deepEqual(q.stats, { scopes: 0, active: 0, pending: 0 });
});
await test('入队预约立即占限额，超额明确拒绝', async () => {
  const q = new SessionScheduler({ ...limits, maxPendingPerScope: 1, maxPendingTotal: 2 }); const gate = deferred();
  const a = q.enqueue('a', () => gate.promise); await assert.rejects(q.enqueue('a', async () => {}), /上限/);
  const b = q.enqueue('b', () => gate.promise); await assert.rejects(q.enqueue('c', async () => {}), /上限/);
  assert.equal(q.stats.pending, 2); gate.release(); await Promise.all([a, b]); assert.equal(q.stats.pending, 0);
});
await test('任务失败仍释放预约并运行后续项', async () => {
  const q = new SessionScheduler(limits);
  const first = q.enqueue('a', async () => { throw new Error('synthetic'); }); const rejected = assert.rejects(first, /synthetic/);
  const next = q.enqueue('a', async () => 42); await rejected; assert.equal(await next, 42); assert.equal(q.stats.scopes, 0);
});
await test('大量会话不突破全局执行上限', async () => {
  const q = new SessionScheduler({ ...limits, maxPendingTotal: 100 }); let active = 0; let maximum = 0;
  await Promise.all(Array.from({ length: 20 }, (_, i) => q.enqueue(String(i), async () => {
    active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 1)); active--;
  })));
  assert.equal(maximum, 2); assert.equal(q.stats.scopes, 0);
});
await test('管线执行前权限热更新拒绝旧预约', async () => {
  const f = makeFixture({ name: 'queue', expectedProvider: 'default' }, 'private:1'); const gate = deferred();
  try {
    const original = f.providers.streamChat; f.providers.streamChat = async (...args) => { await gate.promise; return original(...args); };
    const first = f.pipeline.handle(f.msg, f.api);
    const next = f.pipeline.handle({ ...f.msg, messageId: 11 }, f.api);
    await new Promise(r => setTimeout(r, 1)); f.cfg.trigger.denyUsers = [1]; gate.release();
    await first; assert.equal((await next).replied, false); assert.equal(f.calls.length, 1);
    assert.equal(f.pipeline.queueStats.scopes, 0);
  } finally { f.store.close(); }
});
await test('连续私聊逐条执行且队列不残留', async () => {
  const f = makeFixture({ name: 'burst', expectedProvider: 'default' }, 'private:1');
  try {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => f.pipeline.handle({ ...f.msg, messageId: 20 + i, text: `消息${i}` }, f.api)));
    assert.equal(results.filter(r => r.replied).length, 10); assert.equal(f.calls.length, 10);
    assert.deepEqual(f.pipeline.queueStats, { scopes: 0, active: 0, pending: 0 });
  } finally { f.store.close(); }
});
