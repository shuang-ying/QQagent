import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createServer} from '../src/server/api.js';
import {makeFixture} from './helpers/chat-fixture.js';
export function panelFixture() {
 const f=makeFixture({name:'panel',expectedProvider:'default'},'private:1');
 const deps:any={cfg:f.cfg,store:f.store,providers:f.providers,personas:(f.pipeline as any).personas,log:(f.pipeline as any).log,runtime:()=>({napcatConnected:false,selfId:0,nickname:'',uptimeMs:1,startedAt:1}),diagnostics:()=>({jobs:f.pipeline.background.list()}),embeddingStats:()=>f.store.embeddingStats()};
 return {...f,deps};
}
test('隔离面板：修正、非法请求、来源、遗忘和健康状态',async()=>{
 const f=panelFixture();const {app}=createServer(f.deps);
 try {
  const id=f.store.addFact({userId:1,scope:'private:1',factType:'identity',content:'工程师'});f.store.saveFactEmbedding(id,[1,2],'model');
  let r=await app.request('/api/facts/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'设计师',private:true})});assert.equal(r.status,200);
  assert.equal(f.store.getFactsByUser(1)[0]?.content,'设计师');assert.equal(f.store.embeddingStats().total,0);
  r=await app.request('/api/facts/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({confidence:2})});assert.equal(r.status,400);
  assert.equal((await app.request('/api/health')).status,200);
  assert.equal((await app.request('/api/memory/explain?userId=1&scope=private:1&q=设计')).status,200);
  assert.equal((await app.request('/api/facts/'+id,{method:'DELETE'})).status,200);
  assert.equal((await (await app.request('/api/memory/forgetting')).json()).records.length,1);
 } finally {f.store.close();}
});
test('面板内嵌 JavaScript 编译通过',()=>{
 const html=fs.readFileSync('src/web/panel.html','utf8');let count=0;
 for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)){new vm.Script(match[1]!);count++;} assert.ok(count>0);
});
test('鉴权覆盖读写，拒绝查询 token、坏 JSON 及未鉴权外网监听',async()=>{
 const f=panelFixture(); f.cfg.server.authToken='secret'; const {app}=createServer(f.deps);
 try {
  assert.equal((await app.request('/api/health')).status,401);
  assert.equal((await app.request('/api/health?token=secret')).status,401);
  assert.equal((await app.request('/api/health',{headers:{Authorization:'Bearer secret'}})).status,200);
  const options={method:'PATCH',headers:{Authorization:'Bearer secret','Content-Type':'application/json'},body:'{bad'};
  assert.equal((await app.request('/api/facts/1',options)).status,400);
  f.cfg.server.authToken='';f.cfg.server.host='0.0.0.0';assert.throws(()=>createServer(f.deps));
 } finally {f.store.close();}
});
test('面板 stop 等待已进入的请求完成',async()=>{
 const f=panelFixture();f.cfg.server.port=0;f.cfg.server.enabled=true;f.cfg.server.host='127.0.0.1';
 const server=createServer(f.deps);let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>entered=r);const blocked=new Promise<void>(r=>release=r);
 server.app.get('/drain-test',async c=>{entered();await blocked;return c.text('ok');});server.start();
 try {
  for(let i=0;i<100 && !f.logs.some(x=>x.url);i++)await new Promise(r=>setTimeout(r,5));
  const url=String(f.logs.find(x=>x.url)?.url);assert.ok(url.startsWith('http://127.0.0.1:'));
  const request=fetch(url+'/drain-test');await ready;let closed=false;const closing=server.stop().then(()=>closed=true);
  await new Promise(r=>setTimeout(r,10));assert.equal(closed,false);release();assert.equal(await (await request).text(),'ok');await closing;assert.equal(closed,true);
 }finally{release();await server.stop();f.store.close();}
});
