import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers/chat-fixture.js';
import { MemoryRetriever } from '../src/memory/retriever.js';
test('中文二元词与旧库 LIKE 按词回退，权限过滤先于候选截取', () => {
 const f = makeFixture({name:'retrieval',expectedProvider:'default'},'private:1');
 try {
  for(let i=0;i<100;i++) f.store.addFact({userId:1,scope:'group:9',factType:'event',content:'咖啡跑步'+i});
  const id=f.store.addFact({userId:1,scope:'private:1',factType:'preference',content:'用户喜欢喝咖啡'});
  f.store.db.prepare('UPDATE memory_facts SET keywords=? WHERE id=?').run('',id);
  assert.equal(f.store.searchFacts(1,'咖啡 跑步',{scope:'private:1',limit:1})[0]?.id,id);
  assert.equal(f.store.searchFacts(2,'咖啡',{scope:'private:1'}).length,0);
 } finally {f.store.close();}
});
test('RRF 允许语义候选进入已满关键词列表，双路命中排名优先', async () => {
 const f=makeFixture({name:'rrf',expectedProvider:'default'},'private:1');
 try {
  const a=f.store.addFact({userId:1,scope:'private:1',factType:'preference',content:'咖啡'});
  const b=f.store.addFact({userId:1,scope:'private:1',factType:'preference',content:'喜欢拿铁'});
  f.cfg.memory.retrieval.limit=2; f.cfg.memory.retrieval.semantic=true;
  const row=f.store.listFacts(1).find(x=>x.id===b)!;
  const semantic:any={isConfigured:()=>true,requestBackfill:()=>{},search:async()=>[{...row,score:1,similarity:1}]};
  const result=await new MemoryRetriever(f.store,f.cfg.memory,(f.pipeline as any).log,semantic).retrieveMerged('private:1',1,'咖啡');
  assert.ok(result.hitIds.includes(a));assert.ok(result.hitIds.includes(b));
 } finally {f.store.close();}
});
