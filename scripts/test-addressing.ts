import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { resolveMention } from '../src/pipeline/mention.js';
import { ReplyDispatcher } from '../src/pipeline/dispatch.js';
import { ReplyBehaviorSchema } from '../src/core/types.js';
import { splitMessage } from '../src/pipeline/segments.js';
import type { OneBotAction } from '../src/napcat/action.js';
test('重名不猜、稳定 ID 可选择、禁止全体', () => {
  const people = [{ userId: 1, name: '小明' }, { userId: 2, name: '小明' }, { userId: 3, name: ' A B ' }, { userId: 4, name: 'ab' }];
  assert.equal(resolveMention('小明', people), undefined); assert.equal(resolveMention('AB', people), undefined);
  assert.equal(resolveMention('2', people)?.userId, 2); assert.equal(resolveMention('999', people), undefined); assert.equal(resolveMention('all', people), undefined);
});
test('硬分片和拟人分段共同执行，引用与@只出现一次', async () => {
  const cfg = ReplyBehaviorSchema.parse({ quoteOnReply: true, segmented: { enabled: true, minCharsToSplit: 1, intervalMethod: 'random', interval: [0, 0] } });
  const d = new ReplyDispatcher(cfg, pino({ level: 'silent' })); const payloads: any[] = [];
  const api = { sendToScope: async (_s: string, p: unknown) => { payloads.push(p); return { message_id: payloads.length }; } } as unknown as OneBotAction;
  const result = await d.send(api, { scope: 'group:1', scopeType: 'group', userId: 7, messageId: 8 }, '长'.repeat(1100) + '\n最后一句');
  assert.equal(result.state, 'success'); assert.ok(payloads.length >= 4);
  assert.equal(payloads.flat().filter(s => s.type === 'at').length, 1); assert.equal(payloads.flat().filter(s => s.type === 'reply').length, 1);
  assert.ok(result.pieces.every(p => Array.from(p.content).length <= 500));
});
test('Unicode 分片不拆 emoji', () => { const text = '😀'.repeat(1100); const pieces = splitMessage(text); assert.equal(pieces.join(''), text); assert.equal(pieces.length, 3); });
