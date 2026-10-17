import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonaSchema } from '../src/core/types.js';
import { MemoryStore } from '../src/memory/store.js';
import { ProactiveSpeaker, type ProactiveContext } from '../src/persona/proactive.js';
import { makeFixture } from './helpers/chat-fixture.js';

function fixture(n = 15) {
  const f = makeFixture({ name: 'proactive-cadence', expectedProvider: 'default' }, 'group:123');
  Object.assign(f.cfg.proactive, { enabled: true, mode: 'hybrid', everyNMessages: n,
    probability: 1, relevanceProbability: 1, relevanceThreshold: 0,
    quietHours: [], minIntervalMs: 0, minGapAfterBotMs: 0, maxPerHourPerScope: 0 });
  f.cfg.reply.segmented.enabled = false;
  const persona = PersonaSchema.parse({ id: 'test', name: '测试', systemPrompt: '聊天', proactiveTopics: ['编程'] });
  const speaker = new ProactiveSpeaker(f.cfg.proactive, f.store, (f.pipeline as any).log,
    { resolvePersona: () => persona, sharing: () => 'identity-facts' });
  return { ...f, speaker };
}

function context(messagesSinceBot: number, relevance = 1): ProactiveContext {
  return { scope: 'group:123', scopeType: 'group', lastBotMessageAt: 0, addressed: false,
    recentMessages: [{ senderName: '测试', text: '编程', timestamp: Date.now() }], relevance, messagesSinceBot };
}

for (const n of [10, 15]) for (const mode of ['probability', 'relevant', 'hybrid'] as const)
test(`${mode} 每 ${n} 条才掷一次概率，相关话题也不能绕过间隔`, () => {
  const f = fixture(n), original = Math.random;
  try {
    f.cfg.proactive.mode = mode;
    f.cfg.proactive.probability = f.cfg.proactive.relevanceProbability = 0.5;
    let rolls = 0;
    Math.random = () => { rolls++; return 0.49; };
    const hits: number[] = [];
    for (let count = 1; count <= 3 * n; count++) {
      if (f.speaker.decide(context(count)).speak) hits.push(count);
    }
    assert.deepEqual(hits, [n, 2 * n, 3 * n]);
    assert.equal(rolls, 3);
  } finally { Math.random = original; f.store.close(); }
});

for (const relevant of [false, true])
test(`固定 1000 个均匀样本精确验证${relevant ? '相关' : '基础'}概率，未命中不会补掷`, () => {
  const f = fixture(), original = Math.random;
  try {
    f.cfg.proactive.probability = 0.3; f.cfg.proactive.relevanceProbability = 0.7;
    let rolls = 0, hits = 0;
    Math.random = () => rolls++ / 1000;
    for (let i = 0; i < 1000; i++) {
      const d = f.speaker.decide(context(15, relevant ? 1 : 0));
      if (d.speak) {
        hits++;
        assert.equal(d.strategy, relevant ? 'relevant' : 'probability');
        assert.equal(d.messagesSinceBot, 15);
      }
    }
    assert.equal(rolls, 1000);
    assert.equal(hits, relevant ? 700 : 300);
  } finally { Math.random = original; f.store.close(); }
});

test('阈值 0 不把无关话题归为相关；仅相关模式仍需证据', () => {
  const f = fixture();
  try {
    f.cfg.proactive.relevanceProbability = 0;
    const plain = f.speaker.decide(context(15, 0));
    assert.ok(plain.speak); assert.equal(plain.strategy, 'probability');
    f.cfg.proactive.mode = 'relevant';
    assert.equal(f.speaker.decide(context(15, 0)).speak, false);
    f.cfg.proactive.relevanceProbability = 1;
    const related = f.speaker.decide(context(15, 0.1));
    assert.ok(related.speak); assert.equal(related.strategy, 'relevant');
  } finally { f.store.close(); }
});

for (const n of [10, 15]) for (const relevant of [false, true])
test(`真实入站与主动管线：${relevant ? '话题相关' : '纯主动发言'}每 ${n} 条发送后重新计数`, async () => {
  const f = fixture(n);
  try {
    const hits: number[] = [];
    for (let i = 1; i <= 2 * n; i++) {
      const text = relevant ? '编程怎么学' : '今天天气不错';
      const inbound = await f.pipeline.handle({ ...f.msg, messageId: 100 + i, mentionsBot: false,
        text, segments: [{ type: 'text', data: { text } }] }, f.api);
      assert.equal(inbound.proactiveEligible, true);
      const d = f.speaker.evaluate(f.msg.scope, 123, false);
      if (!d.speak) continue;
      hits.push(i);
      const r = await f.pipeline.handleProactive(f.msg.scope, 'group', 123, d.reason, f.api, d);
      assert.equal(r.replied, true);
      assert.equal(f.store.countUserMessagesSinceLastAssistant(f.msg.scope), 0);
    }
    assert.deepEqual(hits, [n, 2 * n]); assert.equal(f.sends(), 2);
    for (const name of ['主动任务已入队', '主动任务开始模型生成', '主动任务开始投递', '主动任务结束', '主动发言计数已重置']) {
      const logs = f.logs.filter(l => l.msg === name);
      assert.equal(logs.length, 2, name);
      for (const entry of logs) {
        assert.equal(entry.strategy, relevant ? 'relevant' : 'probability');
        assert.equal(entry.proactiveType, relevant ? '话题相关' : '纯主动发言');
        assert.equal(entry.probability, 1); assert.equal(entry.everyNMessages, n);
        assert.equal(entry.messagesSinceBot, n); assert.ok(entry.reason);
      }
    }
    for (const log of f.logs.filter(l => l.msg === '主动发言计数已重置')) {
      assert.equal(log.counterReset, true); assert.equal(log.messagesAfterReset, 0);
    }
  } finally { f.store.close(); }
});

for (const ok of [false, true]) test(`只发表情包${ok ? '成功重置' : '失败保留'}计数且不伪造文本历史`, async () => {
  const f = fixture(10);
  try {
    f.cfg.sticker.enabled = true;
    // 此用例只验证投递后计数，表情概率另由 test:sticker-candidates 覆盖。
    f.cfg.emotion.enabled = true;
    Object.assign(f.cfg.sticker.autoSend, { enabled: true, probability: 1, emotions: [], minIntensity: 0, cooldownSec: 0 });
    (f.pipeline as any).emotion.snapshot = () => ({ analyze: async () =>
      ({ label: 'joy', intensity: 0.9, valence: 0.5, arousal: 0.5, dominance: 0.5, confidence: 1 }) });
    const entry = { file: 'happy.png', absPath: 'synthetic-happy', tags: ['happy'], desc: '开心', useWhen: '开心', emotions: ['joy'] };
    Object.assign(f.pipeline as any, { stickers: { available: true, candidates: () => [entry], list: () => [entry], describeCandidatesForPrompt: () => 'happy' } });
    let sends = 0;
    (f.pipeline as any).dispatcher.snapshot = () => ({ thinkDelay: async () => 0,
      send: async () => { throw Error('不应发送文本'); }, sendSticker: async () => { sends++; return ok; } });
    f.providers.streamChat = async () => ({ content: '[表情:happy]', model: 'm', provider: 'p', latencyMs: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    for (let i = 0; i < 10; i++) f.store.addMessage({ scope: f.msg.scope, userId: 1, role: 'user', content: '聊天' });
    const d = f.speaker.evaluate(f.msg.scope, 123, false); assert.ok(d.speak);
    const r = await f.pipeline.handleProactive(f.msg.scope, 'group', 123, d.reason, f.api, d);
    assert.equal(r.replied, ok); assert.equal(sends, 1);
    assert.equal(f.store.getRecentMessages(f.msg.scope, 20).filter(m => m.role === 'assistant').length, 0);
    assert.equal(f.store.countUserMessagesSinceLastAssistant(f.msg.scope), ok ? 0 : 10);
    assert.equal(f.store.countProactiveSince(f.msg.scope, 0), ok ? 1 : 0);
    assert.equal(f.logs.filter(l => l.msg === '主动发言计数已重置').length, ok ? 1 : 0);
    if (ok) {
      f.store.addMessage({ scope: f.msg.scope, userId: 1, role: 'user', content: '下一条' });
      assert.equal(f.store.countUserMessagesSinceLastAssistant(f.msg.scope), 1);
      assert.equal(f.speaker.evaluate(f.msg.scope, 123, false).speak, false);
      // 即使消息机会点重新满足，纯表情发言也占用时间间隔与小时上限。
      f.cfg.proactive.minGapAfterBotMs = 60000;
      assert.match(f.speaker.decide({ ...context(10, 0), lastBotMessageAt: f.store.getLastAssistantAt(f.msg.scope) }).reason, /刚说过话/);
      f.cfg.proactive.minGapAfterBotMs = 0; f.cfg.proactive.minIntervalMs = 60000;
      assert.match(f.speaker.decide(context(10, 0)).reason, /距离上次主动发言/);
      f.cfg.proactive.minIntervalMs = 0; f.cfg.proactive.maxPerHourPerScope = 1;
      assert.match(f.speaker.decide(context(10, 0)).reason, /上限/);
    }
  } finally { f.store.close(); }
});

for (const state of ['partial', 'unknown'] as const)
test(`主动文本投递 ${state} 但有确认成功片段，仍重置一次计数`, async () => {
  const f = fixture(1);
  try {
    await f.pipeline.handle({ ...f.msg, mentionsBot: false }, f.api);
    (f.pipeline as any).dispatcher.snapshot = () => ({ thinkDelay: async () => 0,
      send: async () => ({ state, pieces: [
        { state: 'success', content: '确认已发送的部分', messageId: 1 },
        { state: state === 'unknown' ? 'unknown' : 'failed', content: '未确认的部分' },
      ] }), sendSticker: async () => { throw Error('部分投递后不再发送图片'); } });
    const r = await f.pipeline.handleProactive(f.msg.scope, 'group', 123, '纯主动发言测试', f.api);
    assert.equal(r.replied, true); assert.equal(r.deliveryState, state);
    assert.equal(f.store.countUserMessagesSinceLastAssistant(f.msg.scope), 0);
    assert.equal(f.store.countProactiveSince(f.msg.scope, 0), 1);
    assert.equal(f.logs.filter(l => l.msg === '主动发言计数已重置').length, 1);
    f.store.addMessage({ scope: f.msg.scope, userId: 1, role: 'user', content: '重新计数' });
    assert.equal(f.store.countUserMessagesSinceLastAssistant(f.msg.scope), 1);
  } finally { f.store.close(); }
});

test('确认主动错误提示也重置计数，防止模型故障持续刷屏', async () => {
  const f = fixture(1);
  try {
    await f.pipeline.handle({ ...f.msg, mentionsBot: false }, f.api);
    f.providers.streamChat = async () => { throw Error('synthetic generation failure'); };
    const r = await f.pipeline.handleProactive(f.msg.scope, 'group', 123, '纯主动发言测试', f.api);
    assert.equal(r.replied, true); assert.equal(f.sends(), 1);
    assert.equal(f.store.countUserMessagesSinceLastAssistant(f.msg.scope), 0);
    assert.equal(f.store.countProactiveSince(f.msg.scope, 0), 1);
  } finally { f.store.close(); }
});

test('旧库加表兼容，计数边界重启后保留、同毫秒新消息计入且话题隔离', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-proactive-counter-')), file = path.join(dir, 'memory.db');
  let store: MemoryStore | undefined;
  try {
    store = new MemoryStore(file);
    store.addMessage({ scope: 'group:123', userId: 1, role: 'user', content: '旧消息' });
    const old = store.currentConversationId('group:123');
    store.db.exec('DROP TABLE proactive_counters'); store.close(); store = new MemoryStore(file);
    assert.equal(store.countUserMessagesSinceLastAssistant('group:123'), 1);
    const now = Date.now(); store.recordProactiveReply('group:123', old, '测试', '', now);
    store.close(); store = new MemoryStore(file);
    assert.equal(store.countUserMessagesSinceLastAssistant('group:123'), 0);
    store.addMessage({ scope: 'group:123', userId: 1, role: 'user', content: '新消息', createdAt: now });
    assert.equal(store.countUserMessagesSinceLastAssistant('group:123'), 1);
    store.newConversation('group:123', '新话题');
    store.addMessage({ scope: 'group:123', userId: 1, role: 'user', content: '新话题消息' });
    store.recordProactiveReply('group:123', old, '旧话题投递完成', '');
    assert.equal(store.countUserMessagesSinceLastAssistant('group:123'), 1);
    store.deleteConversation(old);
    assert.equal(store.db.prepare('SELECT conversation_id FROM proactive_counters WHERE conversation_id=?').get(old), undefined);
    assert.equal(store.recordProactiveReply('group:123', old, '已删除话题投递完成', ''), undefined);
    assert.equal(store.countUserMessagesSinceLastAssistant('group:123'), 1);
  } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const n of [10, 15])
test(`同一管线中的两个群和私聊独立计数：每 ${n} 条的机会、重置及小时限额互不影响`, async () => {
  const f = fixture(n);
  const a = f.msg.scope, b = 'group:456', privateScope = 'private:123';
  const counts = () => [a, b, privateScope].map(scope => f.store.countUserMessagesSinceLastAssistant(scope));
  const receive = (scope: string, messageId: number, mentionsBot = false) => f.pipeline.handle({ ...f.msg,
    scope, groupId: scope === a ? 123 : 456, messageId, mentionsBot,
    text: '普通群聊消息', segments: [{ type: 'text', data: { text: '普通群聊消息' } }] }, f.api);
  try {
    // 相同发送者与消息 ID 在不同群内仍属各自会话，不可合并为全局计数。
    for (let i = 1; i < n; i++) {
      await receive(a, 100 + i);
      if (i < n - 1) await receive(b, 100 + i);
    }
    assert.deepEqual(counts(), [n - 1, n - 2, 0]);
    assert.equal(f.speaker.evaluate(a, 123, false).speak, false);
    assert.equal(f.speaker.evaluate(b, 456, false).speak, false);

    const privateReply = await f.pipeline.handle({ ...f.msg, scope: privateScope, scopeType: 'private',
      groupId: undefined, mentionsBot: false, messageId: 200 }, f.api);
    assert.equal(privateReply.replied, true);
    assert.deepEqual(counts(), [n - 1, n - 2, 0]);

    await receive(a, 100 + n);
    const first = f.speaker.evaluate(a, 123, false); assert.ok(first.speak);
    assert.equal((await f.pipeline.handleProactive(a, 'group', 123, first.reason, f.api, first)).replied, true);
    assert.deepEqual(counts(), [0, n - 2, 0]);

    // A 达到自己的小时限额后，B 仍能在自己的消息机会点发言。
    f.cfg.proactive.maxPerHourPerScope = 1;
    await receive(b, 100 + n - 1); await receive(b, 100 + n);
    const second = f.speaker.evaluate(b, 456, false); assert.ok(second.speak);
    assert.equal(second.messagesSinceBot, n);
    assert.equal((await f.pipeline.handleProactive(b, 'group', 456, second.reason, f.api, second)).replied, true);
    assert.deepEqual(counts(), [0, 0, 0]);
    assert.equal(f.store.countProactiveSince(a, 0), 1);
    assert.equal(f.store.countProactiveSince(b, 0), 1);
    assert.equal(f.store.countProactiveSince(privateScope, 0), 0);

    await receive(a, 300); await receive(b, 300); await receive(b, 301);
    assert.deepEqual(counts(), [1, 2, 0]);
    assert.equal((await receive(b, 302, true)).replied, true);
    assert.deepEqual(counts(), [1, 0, 0]);
    const resets = f.logs.filter(entry => entry.msg === '主动发言计数已重置');
    assert.deepEqual(resets.map(entry => entry.scope), [a, b]);
    assert.notEqual(resets[0]!.conversationId, resets[1]!.conversationId);
  } finally { f.store.close(); }
});

test('纯图片主动发言的会话边界重启后仍独立，其他群和私聊保留累计消息', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-proactive-scopes-')), file = path.join(dir, 'memory.db');
  let store: MemoryStore | undefined;
  const scopes = ['group:123', 'group:456', 'private:123'];
  try {
    store = new MemoryStore(file);
    const now = Date.now();
    for (let i = 0; i < 7; i++) {
      for (const [index, scope] of scopes.entries()) {
        if (i < [5, 7, 3][index]!) store.addMessage({ scope, userId: 1, role: 'user', content: '隔离消息', createdAt: now });
      }
    }
    store.recordProactiveReply(scopes[0]!, store.currentConversationId(scopes[0]!), '纯主动图片', '', now);
    assert.deepEqual(scopes.map(scope => store!.countUserMessagesSinceLastAssistant(scope)), [0, 7, 3]);
    assert.deepEqual(scopes.map(scope => store!.getLastAssistantAt(scope)), [now, 0, 0]);
    store.close(); store = new MemoryStore(file);
    assert.deepEqual(scopes.map(scope => store!.countUserMessagesSinceLastAssistant(scope)), [0, 7, 3]);
    store.recordProactiveReply(scopes[1]!, store.currentConversationId(scopes[1]!), '另一群纯主动图片', '', now);
    store.addMessage({ scope: scopes[0]!, userId: 1, role: 'user', content: 'A 群下一条', createdAt: now });
    assert.deepEqual(scopes.map(scope => store!.countUserMessagesSinceLastAssistant(scope)), [1, 0, 3]);
    assert.deepEqual(scopes.map(scope => store!.countProactiveSince(scope, 0)), [1, 1, 0]);
  } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
