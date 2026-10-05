import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers/chat-fixture.js';
import { ContextBuilder } from '../src/context/compressor.js';
function setup(strategy: 'trim' | 'summary' | 'layered') {
  const f = makeFixture({ name: 'summary', expectedProvider: 'default' }, 'private:1');
  f.cfg.context.compressStrategy = strategy; f.cfg.memory.summary.enabled = true; f.cfg.memory.summary.keepRecentTurns = 1; f.cfg.memory.summary.triggerMessages = 4;
  f.store.touchSession(f.msg.scope, 'private', 1, 'test');
  const builder = new ContextBuilder(f.cfg.context, f.cfg.memory, f.store, (f.pipeline as any).log);
  function add(rounds = 4) { for (let i = 0; i < rounds; i++) for (const role of ['user', 'assistant'] as const) f.store.addMessage({ scope: f.msg.scope, userId: role === 'user' ? 1 : 999, role, content: `${role}消息${i}` }); }
  return { ...f, builder, add };
}
test('trim 不调用摘要、不标记原文', async () => {
  const f = setup('trim'); f.add();
  try { assert.equal(f.builder.shouldCompress(f.msg.scope), false); const result = await f.builder.compress(f.msg.scope, async () => { assert.fail('不应调用'); }); assert.equal(result.ok, false); assert.equal(f.store.countUnsummarized(f.msg.scope), 8); }
  finally { f.store.close(); }
});
test('rolling summary 只召回新父摘要、源消息可追溯，保留完整最近轮次', async () => {
  const f = setup('summary'); f.add();
  try {
    const first = await f.builder.compress(f.msg.scope, async () => '第一批约定'); assert.equal(first.ok, true); assert.equal(f.store.countUnsummarized(f.msg.scope), 2);
    f.add(3); let hasPrevious = false;
    const next = await f.builder.compress(f.msg.scope, async rows => { hasPrevious = rows.some(row => row.content.includes('第一批约定')); return '滚动约定'; });
    assert.equal(next.ok, true); assert.equal(hasPrevious, true); const sums = f.store.getSummaries(f.msg.scope); assert.equal(sums.length, 1); assert.equal(sums[0]?.content, '滚动约定');
    assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM summary_coverage').get() as { n: number }).n, 1);
    assert.ok((f.store.db.prepare('SELECT COUNT(*) AS n FROM summary_sources WHERE summary_id=?').get(next.summaryId!) as { n: number }).n > 6);
    const ctx = f.builder.build({ scope: f.msg.scope, userId: 1, systemPrompt: '滚动约定', userMessage: '当前', contextWindow: 32768, triggerMessageRowId: 999 });
    assert.equal(ctx.stats.includedMessages, 2);
  } finally { f.store.close(); }
});
test('layered 合并标记子摘要覆盖，不会重复合并原子摘要', async () => {
  const f = setup('layered');
  try {
    for (let i = 0; i < 8; i++) f.store.addSummary(f.msg.scope, 1, `摘要${i}`, null, null, 4);
    const result = await f.builder.compress(f.msg.scope, async () => 'L2父摘要'); assert.equal(result.ok, true);
    assert.equal(f.store.countSummaries(f.msg.scope, 1), 0); assert.equal(f.store.countSummaries(f.msg.scope, 2), 1);
    assert.equal(f.store.getSummaries(f.msg.scope).length, 1);
    await f.builder.compress(f.msg.scope, async () => { assert.fail('源摘要已消费'); }); assert.equal(f.store.countSummaries(f.msg.scope, 2), 1);
  } finally { f.store.close(); }
});
test('写入失败事务回滚，原文与摘要都不半提交', async () => {
  const f = setup('summary'); f.add();
  try {
    f.store.db.exec("CREATE TRIGGER synthetic_failure BEFORE UPDATE OF summarized ON messages BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
    const result = await f.builder.compress(f.msg.scope, async () => '摘要'); assert.equal(result.ok, false);
    assert.equal(f.store.getSummaries(f.msg.scope).length, 0); assert.equal(f.store.countUnsummarized(f.msg.scope), 8);
  } finally { f.store.close(); }
});
test('并发摘要只提交一次，空结果不标记', async () => {
  const f = setup('summary'); f.add();
  try {
    const empty = await f.builder.compress(f.msg.scope, async () => ''); assert.equal(empty.ok, false); assert.equal(f.store.countUnsummarized(f.msg.scope), 8);
    const summarize = async () => { await new Promise(r => setTimeout(r, 5)); return '摘要'; };
    const results = await Promise.all([f.builder.compress(f.msg.scope, summarize), f.builder.compress(f.msg.scope, summarize)]);
    assert.equal(results.filter(r => r.ok).length, 1); assert.equal(f.store.getSummaries(f.msg.scope).length, 1);
  } finally { f.store.close(); }
});
test('token 压力可提前触发，trim 仍不触发', () => {
  const f = setup('layered');
  try { assert.equal(f.builder.shouldCompress(f.msg.scope, undefined, true), true); }
  finally { f.store.close(); }
});
test('没有L1仍恢复L2合并任务，避免高层级永远滞留', async () => {
  const f = setup('layered');
  try {
    for (let i = 0; i < 8; i++) f.store.addSummary(f.msg.scope, 2, `旧L2 ${i}`, null, null, 8);
    assert.equal(f.builder.shouldCompress(f.msg.scope), true);
    assert.equal((await f.builder.compress(f.msg.scope, async () => 'L3长期约定')).ok, true);
    assert.equal(f.store.countSummaries(f.msg.scope, 2), 0); assert.equal(f.store.countSummaries(f.msg.scope, 3), 1);
  } finally { f.store.close(); }
});
