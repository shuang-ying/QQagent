import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InboundAdmission, EventDeduper } from '../src/pipeline/admission.js';
import { TriggerPolicy } from '../src/persona/trigger.js';
import { detectMention } from '../src/onebot/normalize.js';
import pino from 'pino';
import { makeFixture } from './helpers/chat-fixture.js';
const log = pino({ level: 'silent' });
await test('群白名单拦截命令与聊天，私聊不受群名单影响', () => {
  const f = makeFixture({ name: 'gate', expectedProvider: 'default' }, 'group:123');
  try {
    f.cfg.trigger.group.enabledGroups = [456];
    const gate = new InboundAdmission(new TriggerPolicy(f.cfg.trigger, log));
    assert.equal(gate.admit({ ...f.msg, text: '/forget' }).allowed, false);
    assert.equal(gate.admit({ ...f.msg, text: 'hi' }).allowed, false);
    assert.equal(gate.admit({ ...f.msg, scopeType: 'private', scope: 'private:1', groupId: undefined }).allowed, true);
  } finally { f.store.close(); }
});
await test('被禁止用户不写历史且不调用模型', async () => {
  const f = makeFixture({ name: 'deny', expectedProvider: 'default' }, 'private:1');
  try { f.cfg.trigger.denyUsers = [1]; assert.equal((await f.pipeline.handle(f.msg, f.api)).replied, false);
    assert.equal(f.calls.length, 0); assert.equal(f.store.stats().messages, 0);
  } finally { f.store.close(); }
});
await test('重复事件只记录、回复一次；同 ID 不同群允许', async () => {
  const f = makeFixture({ name: 'dedup', expectedProvider: 'default' }, 'private:1');
  try {
    assert.equal((await f.pipeline.handle(f.msg, f.api)).replied, true);
    assert.equal((await f.pipeline.handle(f.msg, f.api)).reason, '重复事件'); assert.equal(f.calls.length, 1);
    const gate = new InboundAdmission(new TriggerPolicy(f.cfg.trigger, log));
    assert.equal(gate.admit(f.msg).allowed, true); assert.equal(gate.admit({ ...f.msg, scope: 'group:456' }).allowed, true);
  } finally { f.store.close(); }
});
await test('requireAt true 禁止关键词，false 允许关键词', async () => {
  const f = makeFixture({ name: 'at', expectedProvider: 'default' }, 'group:123');
  try {
    f.cfg.trigger.group.keywords = ['机器人'];
    const msg = { ...f.msg, mentionsBot: false, text: '机器人你好' };
    assert.equal((await f.pipeline.handle(msg, f.api)).replied, false);
    f.cfg.trigger.group.requireAt = false;
    assert.equal((await f.pipeline.handle({ ...msg, messageId: 11 }, f.api)).replied, true);
  } finally { f.store.close(); }
});
await test('完整回复窗口始终记录允许的普通群消息，兼容旧recordAllMessages配置', async () => {
  const f = makeFixture({ name: 'record', expectedProvider: 'default' }, 'group:123');
  try {
    f.cfg.trigger.group.recordAllMessages = false;
    await f.pipeline.handle({ ...f.msg, mentionsBot: false }, f.api);
    assert.equal(f.store.stats().messages, 1);
    await f.pipeline.handle({ ...f.msg, messageId: 11 }, f.api);
    assert.equal(f.store.stats().messages, 3);
  } finally { f.store.close(); }
});
await test('去重缓存有界和过期', () => {
  const d = new EventDeduper(2, 10); assert.equal(d.accept('a', 0), true); assert.equal(d.accept('a', 1), false);
  d.accept('b', 2); d.accept('c', 3); assert.equal(d.size, 2); assert.equal(d.accept('a', 11), true);
});
await test('@全体不呼叫机器人，明确@仍有效', () => {
  assert.equal(detectMention([{ type: 'at', data: { qq: 'all' } }], 1, ''), false);
  assert.equal(detectMention([{ type: 'at', data: { qq: 1 } }], 1, ''), true);
});
