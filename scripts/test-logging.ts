import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorDetails, redactLog } from '../src/core/logger.js';
import { auxiliary, type AuxiliaryFailure } from '../src/pipeline/auxiliary.js';
import { OneBotAction, OneBotActionError } from '../src/onebot/action.js';
import { LlmError } from '../src/llm/client.js';
import { makeFixture } from './helpers/chat-fixture.js';
import pino from 'pino';

test('错误快照保留类型、堆栈、网络原因链，不修改原错误', () => {
  const cause = Object.assign(new Error('dns lookup failed'), {code:'ENOTFOUND',syscall:'getaddrinfo'});
  const error = new TypeError('fetch failed', {cause});
  const result = errorDetails(error);
  assert.equal(result.errorKind, 'network');
  assert.equal(result.error.name, 'TypeError');
  assert.ok(String(result.error.stack).includes('test-logging'));
  assert.equal((result.error.cause as Record<string,unknown>).code, 'ENOTFOUND');
  assert.equal(error.cause, cause);
  assert.equal(cause.message, 'dns lookup failed');
});

test('错误分类与HTTP、OneBot状态保留，原因链及循环对象有界', () => {
  assert.equal(errorDetails(new LlmError('denied', 401)).errorKind, 'authentication');
  assert.equal(errorDetails(new LlmError('limited', 429, true)).errorKind, 'rate-limit');
  assert.equal(errorDetails(new LlmError('请求超时(15ms)')).errorKind, 'timeout');
  const wire = errorDetails(new OneBotActionError('send_group_msg','failed',1400,'unsupported','unknown'));
  assert.equal(wire.error.action, 'send_group_msg');
  assert.equal(wire.error.retcode, 1400);
  assert.equal(wire.error.outcome, 'unknown');
  const cycle = new Error('cycle'); cycle.cause = cycle;
  assert.ok(JSON.stringify(errorDetails(cycle)).includes('TRUNCATED'));
  const object: Record<string,unknown> = {}; object.self = object;
  assert.ok(JSON.stringify(redactLog(object)).includes('TRUNCATED'));
  const hostile = Object.defineProperty({}, 'message', {get:()=>{throw Error('getter');}});
  assert.doesNotThrow(()=>errorDetails(hostile));
  assert.equal(errorDetails('plain failure').error.message, 'plain failure');
});

test('错误消息、堆栈、原因链脱敏，响应正文和请求配置不被复制', () => {
  const cause = new Error('Bearer hidden-bearer apiKey=hidden-key https://host/image?token=hidden-url base64://QUJD');
  const error = Object.assign(new Error('password=hidden-password sk-hidden-api'), {
    cause,response:{body:'hidden-body'},request:{headers:{Authorization:'hidden-header'}}});
  const text = JSON.stringify(errorDetails(error));
  for (const secret of ['hidden-bearer','hidden-key','hidden-url','hidden-password','sk-hidden-api','QUJD','hidden-body','hidden-header']) {
    assert.equal(text.includes(secret), false, secret);
  }
  const log = redactLog({err:error,headers:{Authorization:'hidden-header',Cookie:'hidden-cookie'},accessToken:'hidden-token'});
  assert.ok(!JSON.stringify(log).includes('hidden-'));
});

test('辅助成功不报告，异常、超时和取消各报告一次，保持原降级结果', async () => {
  const events: AuxiliaryFailure[] = [];
  assert.equal(await auxiliary(async()=>1,()=>2,50,undefined,event=>events.push(event)), 1);
  assert.equal(events.length,0);
  const error = new Error('synthetic failure');
  assert.equal(await auxiliary(async()=>{throw error;},()=>3,50,undefined,event=>events.push(event)),3);
  assert.equal(events[0]?.kind,'error'); assert.equal(events[0]?.error,error);
  let aborted = false;
  assert.equal(await auxiliary(signal=>new Promise(resolve=>signal.addEventListener('abort',()=>{
    aborted = true; setTimeout(()=>resolve(99),5);
  })),()=>4,10,undefined,event=>events.push(event)),4);
  assert.equal(aborted,true); assert.equal(events[1]?.kind,'timeout');
  assert.equal(events[1]?.timeoutMs,10); assert.ok(events[1]!.elapsedMs>=0);
  const controller = new AbortController(); controller.abort(error);
  assert.equal(await auxiliary(async()=>1,()=>5,50,controller.signal,event=>events.push(event)),5);
  assert.equal(events[2]?.kind,'cancelled'); assert.equal(events.length,3);
  assert.equal(await auxiliary(async()=>{throw error;},()=>6,50,undefined,()=>{throw Error('observer');}),6);
});

test('OneBot等待失败记录原始网络错误，不重发且保持unknown结果', async () => {
  const logs: Record<string,unknown>[] = [];
  const log = pino({level:'debug',formatters:{log:redactLog}}, {write:line=>{logs.push(JSON.parse(line));}});
  const error = Object.assign(new Error('socket closed'), {code:'ECONNRESET'});
  let sends = 0;
  const api = new OneBotAction(()=>{sends++;return true;},async()=>{
    await new Promise(resolve=>setTimeout(resolve,5)); throw error;
  },log,25);
  await assert.rejects(api.sendToScope('private:1','fixture',{throwOnError:true}), (e:unknown)=>
    e instanceof OneBotActionError && e.outcome==='unknown');
  assert.equal(sends,1);
  const entry = logs.find(item=>item.msg==='OneBot 动作等待响应失败')!;
  assert.equal(entry.action,'send_private_msg'); assert.equal(entry.timeoutMs,25);
  assert.equal(entry.phase,'response'); assert.equal((entry.error as Record<string,unknown>).code,'ECONNRESET');
  assert.equal(JSON.stringify(logs).includes('fixture'),false);
});

for (const mode of ['api','parse','timeout'] as const) test('视觉'+mode+'日志可区分原始原因，文本回退保持可用', async () => {
  const f = makeFixture({name:'logging-vision-'+mode,chat:{provider:'chat',model:'chat-model'},
    vision:{provider:'vision',model:'vision-model'},image:true,visualProviders:['vision'],expectedProvider:'chat'}, 'private:1');
  try {
    f.cfg.media.visionPipeline = true;
    f.cfg.media.timeoutMs = 10;
    f.providers.chat = async () => {
      if (mode==='api') throw new LlmError('vision denied',401);
      if (mode==='timeout') return new Promise(()=>{});
      return {content:'[]',model:'vision-model',provider:'vision',latencyMs:1,
        usage:{promptTokens:1,completionTokens:1,totalTokens:2}};
    };
    assert.equal((await f.pipeline.handle(f.msg,f.api)).replied,true);
    assert.ok(JSON.stringify(f.calls[0]?.messages).includes('图片识别失败'));
    const entry = f.logs.find(item=>item.msg==='视觉资料识别失败，继续文本回复')!;
    assert.equal(entry.phase,'vision-description'); assert.equal(entry.provider,'vision');
    assert.equal(entry.model,'vision-model'); assert.equal(entry.timeoutMs,10);
    assert.equal(entry.failureKind,mode==='timeout'?'timeout':'error');
    if (mode==='api') { assert.equal(entry.errorKind,'authentication'); assert.equal((entry.error as Record<string,unknown>).status,401); }
    if (mode==='parse') assert.equal(entry.errorKind,'invalid-response');
    assert.equal(entry.fallback,'text');
  } finally { f.store.close(); }
});
