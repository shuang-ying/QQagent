import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import pino from 'pino';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { SnowLumaController } from '../src/snowluma/controller.js';
import { snowLumaPaths, validateArchiveEntries } from '../src/snowluma/install.js';
import { releaseAsset, SNOWLUMA_VERSION } from '../src/snowluma/release.js';
import { createServer } from '../src/server/api.js';
import { makeFixture } from './helpers/chat-fixture.js';

const runner = path.resolve('scripts/snowluma-runner.mjs');
function fixture(code?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq snowluma test ')), p = snowLumaPaths(root);
  fs.mkdirSync(p.program, { recursive: true });
  fs.writeFileSync(path.join(p.distribution, 'installation.json'), JSON.stringify({ version: SNOWLUMA_VERSION, platform: process.platform, arch: process.arch }));
  fs.writeFileSync(path.join(p.program, 'index.mjs'), code ?? `
import http from 'node:http'; import fs from 'node:fs';
fs.writeFileSync('synthetic-account.keep','fixture');
const server=http.createServer((req,res)=>{
 res.setHeader('X-Frame-Options','DENY'); res.setHeader('Content-Security-Policy',"frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
 if(req.url==='/api/echo'){let body='';req.on('data',x=>body+=x);req.on('end',()=>res.end(JSON.stringify({auth:req.headers.authorization,cookie:req.headers.cookie,body})));return;}
 if(req.url==='/events'){res.setHeader('Content-Type','text/event-stream');res.write('data: ready\\n\\n');return;}
 res.end('<html>synthetic SnowLuma</html>');
});
server.listen(Number(process.env.SNOWLUMA_WEBUI_PORT)||0,'127.0.0.1',()=>{
 const bytes=Buffer.from('中文日志\\n');process.stdout.write(bytes.subarray(0,2));
 setTimeout(()=>{process.stdout.write(bytes.subarray(2));console.log('<img src=x onerror=alert(1)>');},10);
 console.error('synthetic stderr');
});
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
`);
  const controller = new SnowLumaController(root, pino({ level: 'silent' }), { executable: process.execPath, runner, startupTimeoutMs: 2000 });
  const clean = async () => { await controller.shutdown(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, p, controller, clean };
}

test('固定官方版本、平台及校验和；拒绝压缩包路径穿越', () => {
  assert.equal(releaseAsset('win32', 'x64').sha256.length, 64);
  assert.match(releaseAsset('linux', 'arm64').url, /github.com\/SnowLuma\/SnowLuma\/releases/);
  assert.throws(() => releaseAsset('darwin', 'arm64'), /暂不支持/);
  validateArchiveEntries(['index.mjs', './native/a.node', 'source/a.ts']);
  for (const name of ['../bad', '/tmp/bad', 'C:\\bad', 'a/../../bad']) assert.throws(() => validateArchiveEntries([name]), /非法路径/);
});

test('分离进程与数据路径、重复启动幂等、UTF8终端、停止重启保留数据', { timeout: 10000 }, async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.controller.start(), f.controller.start()]);
    assert.equal(a.phase, 'running'); assert.equal(a.pid, b.pid); assert.notEqual(a.pid, process.pid);
    await delay(30);
    const lines = f.controller.terminal().entries;
    assert.ok(lines.some(x => x.text === '中文日志'));
    assert.ok(lines.some(x => x.stream === 'stderr' && x.text.includes('synthetic stderr')));
    assert.ok(lines.some(x => x.text.includes('<img')));
    const cursor = f.controller.terminal().nextCursor;
    assert.equal(f.controller.terminal(cursor).entries.length, 0);
    await f.controller.stop(); assert.equal(f.controller.status().phase, 'stopped');
    assert.equal(f.controller.status().pid, null);
    assert.ok(fs.existsSync(path.join(f.p.state, 'synthetic-account.keep')));
    assert.equal(fs.existsSync(path.join(f.p.program, 'synthetic-account.keep')), false);
    assert.equal((await f.controller.start()).phase, 'running');
  } finally { await f.clean(); }
});

test('异常退出可诊断，启动过程中停止不留下进程', { timeout: 10000 }, async () => {
  const failed = fixture("console.error('synthetic failure');process.exit(7);");
  try { await assert.rejects(failed.controller.start()); await delay(30); assert.equal(failed.controller.status().lastExitCode, 7); assert.ok(failed.controller.status().error); }
  finally { await failed.clean(); }
  const waiting = fixture("setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));");
  try { const started = waiting.controller.start(); await delay(80); await waiting.controller.stop(); await started; assert.equal(waiting.controller.status().pid, null); }
  finally { await waiting.clean(); }
});

test('父进程关闭 stdin 后 runner 自动停止；不依赖网页保持连接', { timeout: 5000 }, async () => {
  const f = fixture(); let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, [runner, path.join(f.p.program, 'index.mjs')], { cwd: f.p.program,
      env: { ...process.env, SNOWLUMA_WEBUI_PORT: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>(resolve => child!.stdout!.once('data', () => resolve()));
    const ended = new Promise<number | null>(resolve => child!.once('close', code => resolve(code)));
    child.stdin!.end(); assert.equal(await ended, 0);
  } finally { child?.kill(); await f.clean(); }
});

test('SnowLuma 以 argv[1] 创建数据库工作线程时使用官方入口，准备及迁移可完成', { timeout: 8000 }, async () => {
  const f = fixture(`
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
if (isMainThread) {
 const server=http.createServer((_req,res)=>res.end('synthetic SnowLuma'));
 server.listen(Number(process.env.SNOWLUMA_WEBUI_PORT),'127.0.0.1');
 // 对齐上游 message-store-migration-task：线程入口取 argv[1]，不额外传 argv。
 const worker=new Worker(process.argv[1],{workerData:{kind:'synthetic-database-worker',dbPath:path.resolve('data/test/messages.db')},execArgv:process.execArgv});
 worker.on('message',message=>{
  if(message.kind==='ready'){console.log('database-worker-ready');worker.postMessage('start');}
  if(message.kind==='complete')console.log('database-worker-complete');
 });
 worker.on('error',error=>console.error('database-worker-failed: '+error.message));
 process.on('SIGTERM',()=>{worker.terminate().then(()=>{server.closeAllConnections();server.close(()=>process.exit(0));});});
} else {
 fs.mkdirSync(path.dirname(workerData.dbPath),{recursive:true});
 const db=new DatabaseSync(workerData.dbPath);
 db.exec('CREATE TABLE IF NOT EXISTS lifecycle(marker TEXT)');
 parentPort.postMessage({kind:'ready'});
 parentPort.once('message',message=>{if(message==='start'){db.prepare('INSERT INTO lifecycle VALUES(?)').run('completed');db.close();parentPort.postMessage({kind:'complete'});parentPort.close();}});
}
`);
  try {
    await f.controller.start();
    for (let i = 0; i < 200 && !f.controller.terminal().entries.some(line => /database-worker-(complete|failed)/.test(line.text)); i++) await delay(10);
    const lines = f.controller.terminal().entries;
    assert.equal(lines.some(line => line.text.includes('database-worker-failed')), false, JSON.stringify(lines));
    assert.ok(lines.some(line => line.text.includes('database-worker-ready')), '数据库准备工作线程必须执行');
    assert.ok(lines.some(line => line.text.includes('database-worker-complete')), '数据库迁移工作线程必须完成');
    assert.ok(fs.existsSync(path.join(f.p.state, 'data/test/messages.db')));
    assert.equal(f.controller.status().phase, 'running');
  } finally { await f.clean(); }
});

test('取消后台安装及关闭保护，不改变用户运行数据', async () => {
  const f = fixture(); fs.rmSync(f.p.distribution, { recursive: true });
  let cancelled = false;
  const controller = new SnowLumaController(f.root, pino({ level: 'silent' }), { installer: async (_root, report, signal) => {
    report('synthetic install'); await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
  } });
  try {
    assert.equal(controller.install().phase, 'installing');
    assert.equal(controller.install().phase, 'installing');
    await controller.stop(); assert.equal(cancelled, true);
    assert.equal(controller.status().phase, 'not_installed');
    await controller.shutdown(); assert.throws(() => controller.install(), /关闭/);
  } finally { await f.clean(); }
});

test('官方包摘要不匹配时拒绝安装，保留既有运行数据', async () => {
  const f = fixture(); fs.rmSync(f.p.distribution, { recursive: true });
  fs.mkdirSync(f.p.state, { recursive: true }); fs.writeFileSync(path.join(f.p.state, 'keep'), 'synthetic state');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('tampered official archive');
    f.controller.install();
    for (let i = 0; i < 100 && f.controller.status().phase === 'installing'; i++) await delay(10);
    assert.equal(f.controller.status().phase, 'error'); assert.match(f.controller.status().error, /SHA256/);
    assert.equal(fs.existsSync(f.p.distribution), false);
    assert.equal(fs.readFileSync(path.join(f.p.state, 'keep'), 'utf8'), 'synthetic state');
  } finally { globalThis.fetch = original; await f.clean(); }
});

test('受鉴权的控制和内嵌代理：Origin、Cookie、原生鉴权、SSE及退出清理', { timeout: 10000 }, async () => {
  const f = fixture(), chat = makeFixture({ name: 'snow panel', expectedProvider: 'default' }, 'private:1');
  chat.cfg.server.authToken = 'synthetic-panel-token';
  const server = createServer({ cfg: chat.cfg, store: chat.store, providers: chat.providers,
    personas: (chat.pipeline as any).personas, log: pino({ level: 'silent' }), snowLuma: f.controller,
    runtime: () => ({ napcatConnected: false, selfId: 0, nickname: '', uptimeMs: 1, startedAt: 1 }) } as any);
  const call = (url: string, method = 'GET', extra: Record<string, string> = {}) => server.app.request(url, {
    method, headers: { Authorization: 'Bearer synthetic-panel-token', 'Content-Type': 'application/json', ...extra },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  try {
    assert.equal((await server.app.request('/api/snowluma/status')).status, 401);
    assert.equal((await server.app.request('/api/snowluma/start', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await call('/api/snowluma/stop', 'POST', { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await call('/api/snowluma/terminal?after=-1')).status, 400);
    assert.equal((await call('/api/snowluma/start', 'POST')).status, 200);
    const session = await call('/api/snowluma/session', 'POST');
    const { port } = await session.json(); const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(session.headers.get('set-cookie')!, /HttpOnly/);
    const origin = 'http://127.0.0.1:' + port;
    assert.equal((await fetch(origin)).status, 401);
    const embedded = await fetch(origin, { headers: { Cookie: cookie } });
    assert.equal(embedded.status, 200); assert.equal(embedded.headers.get('x-frame-options'), null);
    assert.match(embedded.headers.get('content-security-policy')!, /frame-ancestors http:\/\/localhost/);
    assert.match(embedded.headers.get('content-security-policy')!, /object-src 'none'/);
    assert.equal((await fetch(origin, { headers: { Cookie: cookie, Origin: 'https://evil.invalid' } })).status, 403);
    const echo = await fetch(origin + '/api/echo', { method: 'POST', body: 'native-body',
      headers: { Cookie: cookie + '; snowluma_avatar_session=synthetic', Authorization: 'Bearer synthetic-native-token' } });
    const native = await echo.json(); assert.equal(native.auth, 'Bearer synthetic-native-token');
    assert.equal(native.cookie.includes('qq_agent_snowluma_session'), false); assert.ok(native.cookie.includes('snowluma_avatar_session'));
    assert.equal(native.body, 'native-body');
    const streamed = await fetch(origin + '/events', { headers: { Cookie: cookie } });
    const reader = streamed.body!.getReader(); assert.ok(new TextDecoder().decode((await reader.read()).value).includes('data: ready'));
    await reader.cancel();
    await server.stop(); assert.equal(f.controller.status().pid, null);
    await assert.rejects(fetch(origin));
  } finally { await server.stop(); chat.store.close(); await f.clean(); }
});

test('页面脚本可编译、启动停止入口存在、日志使用 textContent 而非 HTML', () => {
  const html = fs.readFileSync('src/web/panel.html', 'utf8');
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]!);
  assert.ok(html.includes('id="page-snowluma"')); assert.ok(html.includes("snowAction('start')"));
  assert.ok(html.includes("snowAction('stop')")); assert.ok(html.includes("box.textContent += terminal.entries"));
  assert.equal(html.includes('snowTerminal\').innerHTML'), false);
});
