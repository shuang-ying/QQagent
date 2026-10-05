import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { collectImages, collectImagesFromHistory } from '../src/llm/vision.js';
import { makeFixture } from './helpers/chat-fixture.js';
import { contentToText } from '../src/core/types.js';
const images = await Promise.all(['red', 'blue', 'green'].map(async color => ({ type: 'image', data: { file: `base64://${(await sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer()).toString('base64')}` } })));
test('同消息多图与跨消息顺序保持', async () => {
  const direct = await collectImages(images); const hist = await collectImagesFromHistory([
    { rawSegments: JSON.stringify(images.slice(0, 2)), senderName: '甲', createdAt: 1 },
    { rawSegments: JSON.stringify(images.slice(2)), senderName: '乙', createdAt: 2 },
  ], 3);
  assert.deepEqual(hist.images.map(i => i.data), direct.images.map(i => i.part.data)); assert.deepEqual(hist.notes.map(n => n[0]), ['甲', '甲', '乙']);
});
test('超过20条消息仍取最新图片，来源正确', async () => {
  const f = makeFixture({ name: 'latest', expectedProvider: 'default', visualProviders: ['default'] }, 'private:1');
  try {
    f.store.touchSession(f.msg.scope, 'private', 1, 'test');
    for (let i = 0; i < 30; i++) f.store.addMessage({ scope: f.msg.scope, userId: 1, role: 'user', content: '占位', rawSegments: JSON.stringify(i === 29 ? [images[2]] : []) });
    await f.pipeline.handle({ ...f.msg, messageId: 200, segments: [], text: '刚才的图片是什么' }, f.api);
    const last = f.calls.at(-1)!.messages.at(-1)!; assert.ok(Array.isArray(last.content));
    const source = f.store.db.prepare('SELECT sender_id,source_row_id FROM media_sources').get() as { sender_id: number; source_row_id: number };
    assert.equal(source.sender_id, 1); assert.ok(source.source_row_id > 20);
  } finally { f.store.close(); }
});
test('引用旧图跨无关回复可见，切话题后不召回', async () => {
  const f = makeFixture({ name: 'quoted-image', expectedProvider: 'default', visualProviders: ['default'] }, 'private:1');
  try {
    f.store.touchSession(f.msg.scope, 'private', 1, 'test');
    f.store.addMessage({ scope: f.msg.scope, userId: 2, senderName: '原发送者', role: 'user', content: '[图片]', messageId: 55, rawSegments: JSON.stringify([images[0]]) });
    f.store.addMessage({ scope: f.msg.scope, userId: 999, role: 'assistant', content: '无关回复' });
    const ask = { ...f.msg, text: '这张图里是什么', segments: [{ type: 'reply', data: { id: 55 } }], messageId: 201 };
    await f.pipeline.handle(ask, f.api); const last = f.calls.at(-1)!.messages.at(-1)!;
    assert.ok(Array.isArray(last.content)); assert.ok(contentToText(last.content).includes('原发送者'));
    f.store.newConversation(f.msg.scope, 'new'); await f.pipeline.handle({ ...ask, messageId: 202 }, f.api);
    assert.equal(typeof f.calls.at(-1)!.messages.at(-1)!.content, 'string');
  } finally { f.store.close(); }
});
test('消息查询返回最新限定条数，保持时间正序', () => {
  const f = makeFixture({ name: 'window', expectedProvider: 'default' }, 'private:1');
  try { f.store.touchSession(f.msg.scope, 'private', 1, 'test'); for (let i = 0; i < 30; i++) f.store.addMessage({ scope: f.msg.scope, userId: 1, role: 'user', content: String(i) });
    const rows = f.store.getMessagesSinceLastAssistant(f.msg.scope, 20); assert.equal(rows[0]?.content, '10'); assert.equal(rows.at(-1)?.content, '29'); }
  finally { f.store.close(); }
});
