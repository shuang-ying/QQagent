import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import pino from 'pino';
import { NapCatSchema } from '../src/core/types.js';
import { NapCatClient } from '../src/napcat/client.js';
import { OneBotActionError } from '../src/napcat/action.js';
const log = pino({ level: 'silent' });
async function fixture(maxPending = 128) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let socket: WebSocket;
  const requests: Array<{ action: string; echo: string }> = [];
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const request = JSON.parse(String(raw)); requests.push(request);
      if (request.action.startsWith('hold')) return;
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo,
        data: request.action === 'get_login_info' ? { user_id: 10001, nickname: 'test' } : { online: true, good: true } }));
    });
  });
  const client = new NapCatClient(NapCatSchema.parse({ url: `ws://127.0.0.1:${address.port}`, maxPending,
    reconnect: { initialMs: 10, maxMs: 20 }, heartbeat: { intervalMs: 10000, timeoutMs: 10000 } }), log);
  const ready = once(client, 'ready'); client.start(); await ready;
  return { client, requests, socket: () => socket!, close: async () => {
    client.stop(); for (const ws of server.clients) ws.terminate();
    await new Promise<void>(r => server.close(() => r()));
  } };
}
await test('未连接发送清理等待器，无未处理拒绝', async () => {
  const client = new NapCatClient(NapCatSchema.parse({}), log);
  await assert.rejects(client.api.call('send_private_msg'), (e: unknown) => e instanceof OneBotActionError && e.outcome === 'failed');
  assert.equal(client.health.pending, 0); client.stop();
});
await test('连接、账号、API 三层健康状态', async () => {
  const f = await fixture(); try {
    assert.equal(f.client.health.connected, true); assert.equal(f.client.health.accountReady, true);
    assert.equal(f.client.health.apiReady, true); assert.equal(f.client.health.pending, 0);
  } finally { await f.close(); }
});
await test('响应超时清理 pending 并标记结果未知', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.client.api.call('hold', {}, { timeoutMs: 15 }),
      (e: unknown) => e instanceof OneBotActionError && e.outcome === 'unknown');
    assert.equal(f.client.health.pending, 0);
  } finally { await f.close(); }
});
await test('pending 上限阻止发送新请求', async () => {
  const f = await fixture(1); try {
    const pending = f.client.api.call('hold-one', {}, { timeoutMs: 100 });
    const rejected = assert.rejects(pending);
    await assert.rejects(f.client.api.call('hold-two'), /上限/);
    f.client.stop(); await rejected; assert.equal(f.client.health.pending, 0);
    assert.equal(f.requests.filter(r => r.action === 'hold-two').length, 0);
  } finally { await f.close(); }
});
await test('断线立即拒绝请求，重连后迟到 echo 不影响新请求', async () => {
  const f = await fixture(); try {
    const before = f.client.health.generation;
    const held = f.client.api.call('hold-old', {}, { timeoutMs: 1000 });
    const rejection = assert.rejects(held, (e: unknown) => e instanceof OneBotActionError && e.outcome === 'unknown');
    await new Promise(r => setTimeout(r, 10));
    const echo = f.requests.find(r => r.action === 'hold-old')!.echo;
    const ready = once(f.client, 'ready'); f.socket().terminate();
    await rejection; await ready;
    f.socket().send(JSON.stringify({ echo, status: 'ok', retcode: 0, data: 'late' }));
    const result = await f.client.api.getStatus({ throwOnError: true });
    assert.equal(result.online, true); assert.ok(f.client.health.generation > before);
    assert.equal(f.client.health.pending, 0);
  } finally { await f.close(); }
});
await test('背压拒绝且清理等待器', async () => {
  const f = await fixture(); try {
    const ws = (f.client as unknown as { ws: WebSocket }).ws;
    Object.defineProperty(ws, 'bufferedAmount', { get: () => 2000000, configurable: true });
    await assert.rejects(f.client.api.call('hold-pressure'), (e: unknown) => e instanceof OneBotActionError && e.outcome === 'failed');
    assert.equal(f.client.health.pending, 0);
  } finally { await f.close(); }
});
await test('重复 start 不重复连接；stop 清理请求与健康状态', async () => {
  const f = await fixture(); try {
    const generation = f.client.health.generation; f.client.start(); assert.equal(f.client.health.generation, generation);
    const pending = f.client.api.call('hold-stop'); const rejection = assert.rejects(pending);
    f.client.stop(); await rejection;
    assert.equal(f.client.health.pending, 0); assert.equal(f.client.health.apiReady, false); assert.equal(f.client.connected, false);
  } finally { await f.close(); }
});

await test('握手尚未完成时 stop 不产生未处理错误', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new NapCatClient(NapCatSchema.parse({ url: `ws://127.0.0.1:${address.port}` }), log);
  try {
    client.start(); client.stop(); await new Promise(r => setTimeout(r, 10));
    assert.equal(client.connected, false); assert.equal(client.health.pending, 0);
  } finally { client.stop(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(r => server.close(() => r())); }
});
