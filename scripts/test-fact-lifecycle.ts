import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers/chat-fixture.js';
import { FactExtractor } from '../src/memory/extractor.js';
test('增量抽取按用户和话题隔离，明确来源才能入库，重试不重复扫描', async () => {
 const f=makeFixture({name:'facts',expectedProvider:'default'},'private:1'); let calls=0;
 const id=f.store.addMessage({scope:'private:1',userId:1,role:'user',content:'我是一名软件开发工程师'});
 f.store.addMessage({scope:'private:1',userId:2,role:'user',content:'我喜欢打篮球'});
 const manager:any={chat:async()=>{calls++;return {content:JSON.stringify([{type:'identity',content:'用户是工程师',sourceId:id,evidence:'explicit',confidence:0.9},{type:'preference',content:'用户喜欢篮球',sourceId:id+1,evidence:'explicit',confidence:0.9},{type:'goal',content:'推测目标',sourceId:id,evidence:'inferred',confidence:0.9}])};}};
 try {
  const extractor=new FactExtractor(manager,'p','m',f.store,(f.pipeline as any).log,['identity']);
  const rows=f.store.getRecentMessages('private:1',20,false);
  assert.equal(await extractor.extractAndStore(rows,'private:1',1),1);
  assert.equal(f.store.listFacts(1)[0]?.source_msg_id,id);
  assert.equal(await extractor.extractAndStore(rows,'private:1',1),0); assert.equal(calls,1);
 } finally {f.store.close();}
});
test('三种共享策略和私密标记一致，遗忘抑制旧来源但允许新陈述', async () => {
 const f=makeFixture({name:'forget',expectedProvider:'default'},'private:1');
 try {
  const msgId=f.store.addMessage({scope:'private:1',userId:1,role:'user',content:'我喜欢喝可乐'});
  const id=f.store.addFact({userId:1,scope:'private:1',factType:'preference',content:'用户喜欢可乐',shareable:true,sourceMsgId:msgId});
  const opts={scope:'group:2',sharing:'full' as const};
  assert.equal(f.store.getFactsByUser(1,opts).length,1);
  f.store.db.prepare('UPDATE memory_facts SET private=1 WHERE id=?').run(id);
  assert.equal(f.store.getFactsByUser(1,opts).length,0);
  assert.equal(f.store.searchFacts(1,'可乐',{...opts,shareableOnly:true}).length,0);
  f.store.saveFactEmbedding(id,[1,2],'m');
  assert.equal(f.store.searchFactsByVector(1,[1,2],{...opts,model:'m'}).length,0);
  f.store.deleteFact(id);assert.equal(f.store.embeddingStats().total,0);
  let calls=0;const manager:any={chat:async()=>{calls++;return {content:'[]'};}};
  const extractor=new FactExtractor(manager,'p','m',f.store,(f.pipeline as any).log,[]);
  await extractor.extractAndStore(f.store.getRecentMessages('private:1',20,false),'private:1',1);assert.equal(calls,0);
  f.store.addMessage({scope:'private:1',userId:1,role:'user',content:'我现在喜欢喝无糖可乐'});
  await extractor.extractAndStore(f.store.getRecentMessages('private:1',20,false),'private:1',1);assert.equal(calls,1);
 } finally {f.store.close();}
});
test('规范化去重按 scope 隔离，改口保留历史但仅召回新版本', () => {
 const f=makeFixture({name:'versions',expectedProvider:'default'},'private:1');
 try {
  const base={userId:1,scope:'private:1',factType:'preference'};
  const old=f.store.addFact({...base,content:'用户喜欢 Coffee！'});
  assert.equal(f.store.addFact({...base,content:'用户 喜欢 coffee'}),old);
  const other=f.store.addFact({...base,scope:'group:2',content:'用户喜欢 Coffee！'});assert.notEqual(other,old);
  f.store.saveFactEmbedding(old,[1,2],'model');
  const next=f.store.addFact({...base,content:'用户不再喝咖啡',replacesId:old});
  assert.equal(f.store.getFactsByUser(1,{scope:'private:1'})[0]?.id,next);
  assert.equal(f.store.getFactsByUser(1,{scope:'private:1'}).length,1);
  assert.equal(f.store.getFactEmbeddingModel(old),undefined);
  assert.throws(()=>f.store.addFact({...base,content:'错误替换',replacesId:other}));
 } finally {f.store.close();}
});
test('替换写入失败回滚旧版本，抽取非法 JSON 不推进游标',async()=>{
 const f=makeFixture({name:'failure',expectedProvider:'default'},'private:1');
 try {
  const base={userId:1,scope:'private:1',factType:'preference'};const old=f.store.addFact({...base,content:'喜欢咖啡'});
  f.store.db.exec("CREATE TRIGGER fail_replace BEFORE UPDATE OF active ON memory_facts BEGIN SELECT RAISE(ABORT,'fail replace'); END");
  assert.throws(()=>f.store.addFact({...base,content:'不再喝咖啡',replacesId:old}));assert.equal(f.store.getFactsByUser(1).length,1);assert.equal(f.store.getFactsByUser(1)[0]?.id,old);
  f.store.addMessage({scope:base.scope,userId:1,role:'user',content:'我现在不再喜欢喝咖啡了'});
  const extractor=new FactExtractor({chat:async()=>({content:'[broken]'})} as any,'p','m',f.store,(f.pipeline as any).log,[]);
  await assert.rejects(()=>extractor.extractAndStore(f.store.getRecentMessages(base.scope,20,false),base.scope,1));assert.equal(f.store.db.prepare('SELECT * FROM fact_cursors').all().length,0);
 }finally{f.store.close();}
});
