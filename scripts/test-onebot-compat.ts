import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { AppConfigSchema } from '../src/core/types.js';
import { OneBotClient } from '../src/onebot/client.js';
import { NapCatClient } from '../src/napcat/client.js';
import { OneBotAction, OneBotActionError } from '../src/onebot/action.js';
const log = pino({ level: 'silent' });
await test('旧类名和通用入口相同', () => assert.equal(NapCatClient, OneBotClient));
await test('旧 napcat 配置和模式保留兼容', () => {
  const cfg = AppConfigSchema.parse({ napcat: { url: 'ws://old', mode: 'reverse-ws-client' } });
  assert.equal(cfg.napcat.url, 'ws://old'); assert.equal(cfg.napcat.mode, 'reverse-ws-client');
});
await test('onebot 字段优先并继承旧配置未覆盖项', () => {
  const cfg = AppConfigSchema.parse({ napcat: { accessToken: 'legacy', url: 'ws://old' }, onebot: { url: 'ws://new' } });
  assert.equal(cfg.napcat.url, 'ws://new'); assert.equal(cfg.napcat.accessToken, 'legacy'); assert.equal(cfg.napcat.mode, 'forward-ws');
});
await test('扩展明确不支持后停止调用，重置后可重新检查', async () => {
  let sends = 0;
  const api = new OneBotAction(() => { sends++; return true; }, async () => ({ status: 'failed', retcode: 1404, data: null }), log);
  await assert.rejects(api.sendFriendPoke(1, { throwOnError: true }));
  await assert.rejects(api.sendFriendPoke(1, { throwOnError: true }));
  assert.equal(sends, 1); assert.equal(api.extensionCapabilities.friend_poke, 'unsupported');
  api.resetCapabilities(); await assert.rejects(api.sendFriendPoke(1, { throwOnError: true })); assert.equal(sends, 2);
});
await test('配置关闭扩展不发请求，标准动作不受影响', async () => {
  let sends = 0;
  const api = new OneBotAction(() => { sends++; return true; }, async () => ({ status: 'ok', retcode: 0, data: {} }), log,
    30, undefined, { friend_poke: false });
  await assert.rejects(api.sendFriendPoke(1)); await api.getStatus(); assert.equal(sends, 1);
  assert.equal(api.extensionCapabilities.friend_poke, 'disabled');
});
await test('扩展超时结果未知，不误判不支持', async () => {
  const api = new OneBotAction(() => true, async () => { throw new Error('timeout'); }, log);
  await assert.rejects(api.sendFriendPoke(1), (e: unknown) => e instanceof OneBotActionError && e.outcome === 'unknown');
  assert.equal(api.extensionCapabilities.friend_poke, 'unknown');
});
await test('成功响应记录支持能力', async () => {
  const api = new OneBotAction(() => true, async () => ({ status: 'ok', retcode: 0, data: {} }), log);
  await api.sendFriendPoke(1); assert.equal(api.extensionCapabilities.friend_poke, 'supported');
});
