import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import pino from 'pino';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackgroundQueue } from '../src/pipeline/background.js';
const log = pino({ level: 'silent' });
const pause = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean) { for (let i = 0; i < 150; i++) { if (fn()) return; await pause(); } assert.fail('等待后台任务超时'); }
test('去重、前台优先和成功状态', async () => {
  const db = new DatabaseSync(':memory:'); let busy = true, calls = 0;
  const q = new BackgroundQueue(db, log, () => busy); q.register('x', async () => { calls++; });
  const id = q.enqueue('same', 'x', 's', 'c', {}); assert.equal(q.enqueue('same', 'x', 's', 'c', {}), id);
  await pause(30); assert.equal(calls, 0); busy = false;
  await until(() => q.list()[0]?.state === 'succeeded'); assert.equal(calls, 1); q.stop(); db.close();
});
test('持久任务恢复，包括中断 running', async () => {
  const db = new DatabaseSync(':memory:'); const q = new BackgroundQueue(db, log, () => true);
  q.enqueue('a', 'x', 's', 'c', { value: 7 }); q.stop(); db.exec("UPDATE background_jobs SET state='running'");
  let value = 0; const restored = new BackgroundQueue(db, log); restored.register('x', async data => { value = data.value; });
  await until(() => restored.list()[0]?.state === 'succeeded'); assert.equal(value, 7); restored.stop(); db.close();
});
test('失败重试有上限、异常可查询', async () => {
  const db = new DatabaseSync(':memory:'); const q = new BackgroundQueue(db, log, () => false, 1, 1);
  q.register('x', async () => { throw new Error('synthetic'); }); q.enqueue('a', 'x', 's', 'c', {});
  await until(() => q.list()[0]?.state === 'failed'); assert.equal(q.list()[0]?.attempts, 3); assert.equal(q.list()[0]?.error, 'synthetic'); q.stop(); db.close();
});
test('scope 取消同时覆盖排队和运行，不写成功状态', async () => {
  const db = new DatabaseSync(':memory:'); const q = new BackgroundQueue(db, log); let aborted = false;
  q.register('x', async (_, signal) => { await new Promise<void>(r => signal.addEventListener('abort', () => { aborted = true; r(); })); });
  q.enqueue('a', 'x', 's', 'c', {}); q.enqueue('b', 'x', 's', 'c', {});
  await until(() => q.list()[0]?.state === 'running'); q.cancelScope('s'); await pause();
  assert.equal(aborted, true); assert.ok(q.list().every(x => x.state === 'cancelled')); q.stop(); db.close();
});
test('关闭文件数据库后重新打开可恢复任务', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-job-')); const file = path.join(dir, 'jobs.sqlite');
  try {
    const first = new DatabaseSync(file); const q = new BackgroundQueue(first, log, () => true); q.enqueue('persistent', 'x', 's', 'c', { original: 'retained' }); q.stop(); first.close();
    const reopened = new DatabaseSync(file); const restored = new BackgroundQueue(reopened, log); let payload: unknown;
    restored.register('x', async data => { payload = data.original; });
    await until(() => restored.list()[0]?.state === 'succeeded'); assert.equal(payload, 'retained'); restored.stop(); reopened.close();
  } finally { await fs.unlink(file); await fs.rmdir(dir); }
});
