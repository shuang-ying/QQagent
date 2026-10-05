import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {makeFixture} from './helpers/chat-fixture.js';
const cases=fs.readFileSync('scripts/fixtures/agent-replay.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line) as {id:string;kind:string;text:string});
assert.ok(cases.length>=100); const metrics:Array<{id:string;latencyMs:number;calls:number;deliveries:number}>=[];
for(const row of cases) await test('固定回放 '+row.id,async()=>{
 const group=row.kind.startsWith('group') || row.kind==='deny-group';
 const f=makeFixture({name:row.id,expectedProvider:'default',image:row.kind==='image-fallback'},group?'group:123':'private:1');
 const msg={...f.msg,text:row.text,messageId:100,mentionsBot:row.kind!=='group-silent'}; const started=performance.now();
 try {
  if(row.kind==='deny-user')f.cfg.trigger.denyUsers=[1];
  if(row.kind==='deny-group')f.cfg.trigger.group.enabledGroups=[999];
  if(row.kind==='sharing'){
   const id=f.store.addFact({userId:1,scope:'group:9',factType:'identity',content:row.text,shareable:true});
   assert.ok(f.store.getFactsByUser(1,{scope:msg.scope,shareableOnly:true}).some(x=>x.id===id));
   assert.equal(f.store.getFactsByUser(2,{scope:msg.scope,shareableOnly:true}).length,0);
  }
  if(row.kind==='forget'){
   const id=f.store.addFact({userId:1,scope:msg.scope,factType:'preference',content:row.text});f.store.saveFactEmbedding(id,[1,2],'mock');f.store.deleteFact(id);assert.equal(f.store.getFactsByUser(1).length,0);assert.equal(f.store.embeddingStats().total,0);
  }
  if(row.kind==='topic-switch'){
   let release:()=>void=()=>{};let entered:()=>void=()=>{};const ready=new Promise<void>(r=>entered=r);const original=f.providers.streamChat;
   f.providers.streamChat=async(...args:Parameters<typeof original>)=>{entered();await new Promise<void>(r=>release=r);return original(...args);};
   const running=f.pipeline.handle(msg,f.api);await ready;f.store.newConversation(msg.scope,'新话题');release();await running;assert.equal(f.sends(),0);
  }else{
   const result=await f.pipeline.handle(msg,f.api);
   if(['deny-user','deny-group','group-silent'].includes(row.kind)){assert.equal(result.replied,false);assert.equal(f.sends(),0);}
   else {assert.equal(result.replied,true);assert.ok(f.sends()>0);}
   if(row.kind==='duplicate'){const count=f.sends();await f.pipeline.handle(msg,f.api);assert.equal(f.sends(),count);}
  }
  metrics.push({id:row.id,latencyMs:Number((performance.now()-started).toFixed(3)),calls:f.calls.length,deliveries:f.sends()});
 }finally{f.store.close();}
});
const latencies=metrics.map(m=>m.latencyMs).sort((a,b)=>a-b);
const report={kind:'offline-mock',cases:cases.length,passed:metrics.length,failed:cases.length-metrics.length,p50Ms:latencies[Math.floor(latencies.length*.5)],p95Ms:latencies[Math.floor(latencies.length*.95)],calls:metrics.reduce((s,m)=>s+m.calls,0),deliveries:metrics.reduce((s,m)=>s+m.deliveries,0),realCost:null,personaQuality:null,note:'隔离 mock 仅验证行为约束，不能代表真实网络延迟、模型账单或人格一致性',metrics};
console.log(JSON.stringify({...report,metrics:undefined}));if(process.env.REPLAY_OUTPUT)fs.writeFileSync(process.env.REPLAY_OUTPUT,JSON.stringify(report,null,2)+'\n');
