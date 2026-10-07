import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionScheduler } from '../src/pipeline/scheduler.js';
import { makeFixture } from './helpers/chat-fixture.js';
import { contentToText, type InboundMessage } from '../src/core/types.js';
import {OneBotActionError} from '../src/onebot/action.js';
import type {SpeechService} from '../src/llm/speech.js';
test('直接提问先于排队的主动任务', async () => {
  const q = new SessionScheduler({ maxPendingPerScope: 8, maxPendingTotal: 20, maxActiveScopes: 1 });
  let release!: () => void; const order: string[] = [];
  const running = q.enqueue('s', () => new Promise<void>(r => release = r));
  const low = q.enqueue('s', async () => { order.push('proactive'); }, 2);
  const high = q.enqueue('s', async () => { order.push('direct'); }, 0);
  await new Promise(r => setTimeout(r, 1)); release(); await Promise.all([running, low, high]);
  assert.deepEqual(order, ['direct', 'proactive']);
});
test('短消息合并一次，原文留档、输入不重复', async () => {
  const f = makeFixture({ name: 'merge', expectedProvider: 'default' }, 'private:1'); f.cfg.scheduling.shortMessageMergeMs = 20;
  try {
    const results = await Promise.all(['第一段', '补充条件', '最后问题'].map((text, i) => f.pipeline.handle({ ...f.msg, text, messageId: 20 + i }, f.api)));
    assert.equal(results.filter(r => r.replied).length, 1); assert.equal(f.calls.length, 1);
    const input = f.calls[0]!.messages.map(m => contentToText(m.content)).join('\n');
    for (const text of ['第一段', '补充条件', '最后问题']) assert.equal(input.split(text).length - 1, 1);
    assert.equal(f.store.getRecentMessages(f.msg.scope, 20).filter(m => m.role === 'user').length, 3);
  } finally { f.store.close(); }
});
test('合并等待中切换话题取消，不归入新话题', async () => {
  const f = makeFixture({ name: 'merge-cancel', expectedProvider: 'default' }, 'private:1'); f.cfg.scheduling.shortMessageMergeMs = 40;
  try { const task = f.pipeline.handle(f.msg, f.api); f.store.newConversation(f.msg.scope, 'new'); assert.equal((await task).replied, false); assert.equal(f.calls.length, 0); }
  finally { f.store.close(); }
});
test('冷却中引用机器人触发，引用别人不触发', async () => {
  const f = makeFixture({ name: 'quote', expectedProvider: 'default' }, 'group:123'); f.cfg.trigger.group.cooldownMs = 100000;
  try {
    await f.pipeline.handle(f.msg, f.api);
    const quote = { ...f.msg, messageId: 21, mentionsBot: false, segments: [{ type: 'reply', data: { id: 1 } }] };
    assert.equal((await f.pipeline.handle(quote, f.api)).replied, true);
    assert.equal((await f.pipeline.handle({ ...quote, messageId: 22, segments: [{ type: 'reply', data: { id: 99999 } }] }, f.api)).replied, false);
  } finally { f.store.close(); }
});

function deferred() { let release!: () => void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release}; }
function proactiveFixture() {
  const f=makeFixture({name:'proactive-cancellation',expectedProvider:'default'},'group:123');
  Object.assign(f.cfg.proactive,{enabled:true,mode:'hybrid',quietHours:[],minGapAfterBotMs:0,minIntervalMs:0,maxPerHourPerScope:0});
  f.cfg.reply.segmented.enabled=false;
  return f;
}
function blockFirstModel(f:ReturnType<typeof proactiveFixture>) {
  const started=deferred(),done=deferred(),original=f.providers.streamChat;
  let signal:AbortSignal|undefined,calls=0;
  f.providers.streamChat=async(...args)=>{
    if(++calls===1){signal=args[4]?.signal;started.release();await done.promise;}
    return original(...args);
  };
  return {started:started.promise,release:done.release,signal:()=>signal,calls:()=>calls};
}

test('普通群消息不取消主动生成，重复候选只生成和投递一次', {timeout:5000}, async()=>{
  const f=proactiveFixture(),model=blockFirstModel(f);
  try{
    await f.pipeline.handle({...f.msg,mentionsBot:false},f.api);
    const running=f.pipeline.handleProactive(f.msg.scope,'group',123,'测试',f.api);await model.started;
    const inbound=await f.pipeline.handle({...f.msg,messageId:22,text:'继续刚才的话题',mentionsBot:false},f.api);
    assert.equal(inbound.proactiveEligible,true);assert.equal(model.signal()?.aborted,false);
    const duplicate=await f.pipeline.handleProactive(f.msg.scope,'group',123,'再次命中',f.api);
    assert.equal(duplicate.replied,false);assert.match(duplicate.reason!,/已有主动任务/);
    assert.equal(model.signal()?.aborted,false);assert.equal(model.calls(),1);
    model.release();const result=await running;
    assert.equal(result.replied,true);assert.equal(result.deliveryState,'success');assert.equal(f.sends(),1);
    const queued=f.logs.find(l=>l.msg==='主动任务已入队')!;
    const success=f.logs.find(l=>l.msg==='主动任务结束'&&l.replied===true)!;
    const skipped=f.logs.find(l=>l.msg==='主动任务结束'&&l.phase==='duplicate')!;
    assert.equal(success.turnId,queued.turnId);assert.equal(success.outcome,'success');
    assert.notEqual(skipped.turnId,queued.turnId);assert.equal(skipped.existingTurnId,queued.turnId);
    assert.ok(f.logs.some(l=>l.msg==='主动任务开始模型生成'&&l.turnId===queued.turnId));
    assert.ok(f.logs.some(l=>l.msg==='主动任务开始投递'&&l.turnId===queued.turnId));
  }finally{model.release();f.store.close();}
});

for(const kind of ['at','reply','keyword'] as const) test(kind+'被动触发抢占主动任务，日志记录实际原因', {timeout:5000},async()=>{
  const f=proactiveFixture(),model=blockFirstModel(f);
  try{
    if(kind==='keyword'){f.cfg.trigger.group.requireAt=false;f.cfg.trigger.group.keywords=['帮助'];}
    if(kind==='reply'){
      f.store.touchSession(f.msg.scope,'group',123,'test');
      f.store.addMessage({scope:f.msg.scope,userId:999,role:'assistant',content:'之前的回复',messageId:500});
    }
    await f.pipeline.handle({...f.msg,mentionsBot:false},f.api);
    const running=f.pipeline.handleProactive(f.msg.scope,'group',123,'测试',f.api);await model.started;
    const passive=f.pipeline.handle({...f.msg,messageId:22,mentionsBot:kind==='at',text:kind==='keyword'?'请帮助我':'请回答',
      segments:kind==='reply'?[{type:'reply',data:{id:500}},{type:'text',data:{text:'请回答'}}]:[{type:'text',data:{text:'请回答'}}]},f.api);
    assert.equal(model.signal()?.aborted,true);model.release();
    const [old,current]=await Promise.all([running,passive]);
    assert.equal(old.replied,false);assert.match(old.reason!,/被动回复抢占主动任务/);
    assert.equal(current.replied,true);assert.equal(current.proactiveEligible,undefined);assert.equal(f.sends(),1);
    assert.ok(f.logs.some(l=>l.msg==='请求取消主动任务'&&String(l.reason).includes('被动回复抢占')));
    assert.ok(f.logs.some(l=>l.msg==='主动任务结束'&&l.reason===old.reason));
  }finally{model.release();f.store.close();}
});

test('主动任务排队时的新消息进入执行窗口，排队的重复候选被跳过', {timeout:5000},async()=>{
  const f=proactiveFixture(),model=blockFirstModel(f);f.cfg.scheduling.maxActiveScopes=1;
  try{
    const blocker=f.pipeline.handle({...f.msg,scope:'private:2',scopeType:'private',groupId:undefined},f.api);await model.started;
    await f.pipeline.handle({...f.msg,mentionsBot:false},f.api);
    const queued=f.pipeline.handleProactive(f.msg.scope,'group',123,'测试',f.api);
    const duplicate=await f.pipeline.handleProactive(f.msg.scope,'group',123,'再次命中',f.api);
    assert.match(duplicate.reason!,/已有主动任务/);
    await f.pipeline.handle({...f.msg,messageId:22,text:'排队新增的上下文',mentionsBot:false},f.api);
    model.release();await blocker;const result=await queued;
    assert.equal(result.replied,true);assert.equal(model.calls(),2);
    const prompt=f.calls[1]!.messages.map(m=>contentToText(m.content)).join('\n');
    assert.ok(prompt.includes('排队新增的上下文'));
  }finally{model.release();f.store.close();}
});

test('等待期间机器人已回复，即使冷却为零也不追加旧主动机会', {timeout:5000},async()=>{
  const f=proactiveFixture(),model=blockFirstModel(f);f.cfg.trigger.group.cooldownMs=0;
  try{
    const passive=f.pipeline.handle(f.msg,f.api);await model.started;
    const proactive=f.pipeline.handleProactive(f.msg.scope,'group',123,'测试',f.api);
    model.release();assert.equal((await passive).replied,true);
    const result=await proactive;assert.equal(result.replied,false);assert.match(result.reason!,/排队期间机器人已回复/);
    assert.equal(model.calls(),1);assert.equal(f.sends(),1);
    assert.ok(f.logs.some(l=>l.msg==='主动任务结束'&&l.phase==='queued'&&l.reason===result.reason));
  }finally{model.release();f.store.close();}
});

for(const action of ['switch','delete','shutdown'] as const) test('主动生成中'+action+'仍取消任务并清空队列', {timeout:5000},async()=>{
  const f=proactiveFixture(),model=blockFirstModel(f);
  try{
    await f.pipeline.handle({...f.msg,mentionsBot:false},f.api);
    const running=f.pipeline.handleProactive(f.msg.scope,'group',123,'测试',f.api);await model.started;
    let shutdown:Promise<boolean>|undefined;
    if(action==='switch')f.store.newConversation(f.msg.scope,'新话题');
    else if(action==='delete')f.store.deleteConversation(f.store.currentConversationId(f.msg.scope));
    else shutdown=f.pipeline.shutdown();
    assert.equal(model.signal()?.aborted,true);model.release();const result=await running;
    assert.equal(result.replied,false);assert.equal(f.sends(),0);assert.equal(f.pipeline.queueStats.pending,0);
    assert.match(result.reason!,action==='shutdown'?/实例正在关闭/:/话题已切换或删除/);
    if(shutdown)assert.equal(await shutdown,true);
    assert.ok(f.logs.some(l=>l.msg==='主动任务结束'&&l.reason===result.reason));
  }finally{model.release();f.store.close();}
});

for(const outcome of ['failed','unknown'] as const) test('主动投递'+outcome+'明确记录，失败的被动回复不提供主动机会',async()=>{
  const f=proactiveFixture();
  try{
    f.api.sendToScope=async()=>{throw new OneBotActionError('send','failed',-1,'模拟拒绝或超时',outcome);};
    await f.pipeline.handle({...f.msg,mentionsBot:false},f.api);
    const proactive=await f.pipeline.handleProactive(f.msg.scope,'group',123,'测试',f.api);
    assert.equal(proactive.replied,false);assert.equal(proactive.deliveryState,outcome);
    const ended=f.logs.find(l=>l.msg==='主动任务结束')!;assert.equal(ended.phase,'delivery');assert.equal(ended.outcome,outcome);
    assert.equal(f.logs.some(l=>l.msg==='✅ 已回复'),false);
    const passive=await f.pipeline.handle({...f.msg,messageId:22},f.api);
    assert.equal(passive.replied,false);assert.equal(passive.proactiveEligible,undefined);
  }finally{f.store.close();}
});

test('拒绝、去重的消息不提供主动机会',async()=>{
  const f=proactiveFixture();
  try{
    const admitted=await f.pipeline.handle({...f.msg,mentionsBot:false},f.api);assert.equal(admitted.proactiveEligible,true);
    const duplicate=await f.pipeline.handle({...f.msg,mentionsBot:false},f.api);assert.equal(duplicate.proactiveEligible,undefined);
    f.cfg.trigger.denyUsers.push(f.msg.userId);
    const denied=await f.pipeline.handle({...f.msg,messageId:22,mentionsBot:false},f.api);assert.equal(denied.proactiveEligible,undefined);
  }finally{f.store.close();}
});

test('群语音识别期间不取消，识别后命中关键词才抢占', {timeout:5000},async()=>{
  const f=proactiveFixture(),model=blockFirstModel(f),asrStarted=deferred(),asrDone=deferred();
  try{
    f.cfg.trigger.group.requireAt=false;f.cfg.trigger.group.keywords=['帮助'];
    f.cfg.speech.asr.enabled=true;f.cfg.speech.asr.groupAll=true;
    f.pipeline.attachSpeech({transcribeInbound:async(msg:InboundMessage)=>{asrStarted.release();await asrDone.promise;return {...msg,text:'请帮助我'};},replyVoice:async()=>{}} as unknown as SpeechService);
    await f.pipeline.handle({...f.msg,mentionsBot:false},f.api);
    const running=f.pipeline.handleProactive(f.msg.scope,'group',123,'测试',f.api);await model.started;
    const audio=f.pipeline.handle({...f.msg,messageId:22,mentionsBot:false,text:'[语音]',segments:[{type:'record',data:{file:'mock.wav'}}]},f.api);
    await asrStarted.promise;assert.equal(model.signal()?.aborted,false);
    asrDone.release();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(model.signal()?.aborted,true);model.release();
    const [old,passive]=await Promise.all([running,audio]);assert.equal(old.replied,false);assert.equal(passive.replied,true);
    assert.match(old.reason!,/命中关键词/);assert.equal(f.sends(),1);
  }finally{model.release();asrDone.release();f.store.close();}
});

test('排队时关闭主动发言，执行前拒绝且记录原因', {timeout:5000},async()=>{
  const f=proactiveFixture(),model=blockFirstModel(f);f.cfg.scheduling.maxActiveScopes=1;
  try{
    const blocker=f.pipeline.handle({...f.msg,scope:'private:2',scopeType:'private',groupId:undefined},f.api);await model.started;
    await f.pipeline.handle({...f.msg,mentionsBot:false},f.api);
    const queued=f.pipeline.handleProactive(f.msg.scope,'group',123,'测试',f.api);
    f.cfg.proactive.enabled=false;model.release();await blocker;
    const result=await queued;assert.equal(result.replied,false);assert.equal(result.reason,'主动发言已关闭');
    assert.equal(model.calls(),1);assert.ok(f.logs.some(l=>l.msg==='主动任务结束'&&l.reason===result.reason&&l.phase==='queued'));
  }finally{model.release();f.store.close();}
});
