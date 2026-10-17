import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import {parse} from 'yaml';
import {AppConfigSchema, ProviderSchema, TOKEN_BUDGET_PURPOSES, type ChatMessage} from '../src/core/types.js';
import {ProviderManager} from '../src/llm/manager.js';
import {outputTokenBudget} from '../src/llm/token-budgets.js';
import {validateSettings,assignPath} from '../src/config/settings.js';
import {setConfigValues} from '../src/config/writer.js';
import {createServer} from '../src/server/api.js';
import {makeFixture} from './helpers/chat-fixture.js';

test('旧配置各用途默认保持原预算，独立配置及未知用途互不影响',()=>{
  const cfg=AppConfigSchema.parse({});
  for(const purpose of TOKEN_BUDGET_PURPOSES) assert.equal(outputTokenBudget(cfg.llm,purpose,600),600);
  cfg.llm.tokenBudgets.vision=4096;
  assert.equal(outputTokenBudget(cfg.llm,'vision',1200),4096);
  assert.equal(outputTokenBudget(cfg.llm,'sticker',600),600);
  assert.equal(outputTokenBudget(cfg.llm,'embedding',100),100);
  for(const value of [-1,1.5,131073,'4000',null])
    assert.equal(AppConfigSchema.safeParse({llm:{tokenBudgets:{chat:value}}}).success,false);
});

test('每种真实调用用途都使用配置预算，含扩大重试；热更新及模型上下文裁剪生效',async()=>{
  const cfg=AppConfigSchema.parse({llm:{request:{maxRetries:0}}});
  const manager=Object.create(ProviderManager.prototype) as ProviderManager;
  const calls:Array<{purpose:string;maxTokens:number}>=[];
  Object.assign(manager,{providers:{test:ProviderSchema.parse({baseURL:'https://fixture.invalid',protocol:'openai',
    models:[{id:'mock',contextWindow:4000,supportsVision:true}]})},llmCfg:cfg.llm,
    log:pino({level:'silent'}),cache:{version:1,entries:{}},defaultContextWindow:32768,usage:new Map(),saveCache:()=>{},
    client:{chat:async(_messages:ChatMessage[],opts:{purpose:string;maxTokens:number})=>{
      calls.push({purpose:opts.purpose,maxTokens:opts.maxTokens});
      return {content:'ok',model:'mock',provider:'test',latencyMs:1,usage:{promptTokens:1,completionTokens:1,totalTokens:2}};
    }}});
  for(const purpose of TOKEN_BUDGET_PURPOSES){
    cfg.llm.tokenBudgets[purpose]=900;
    await manager.chat([{role:'user',content:'hi'}],'test','mock',{purpose,maxTokens:600});
    await manager.chat([{role:'user',content:'hi'}],'test','mock',{purpose,maxTokens:1800});
    assert.equal(calls.at(-1)?.maxTokens,900);
    assert.equal(calls.at(-2)?.maxTokens,900);
    cfg.llm.tokenBudgets[purpose]=0;
  }
  await manager.chat([{role:'user',content:'hi'}],'test','mock',{purpose:'sticker',maxTokens:1800});
  assert.equal(calls.at(-1)?.maxTokens,1800);
  cfg.llm.tokenBudgets.chat=8192;
  await manager.chat([{role:'user',content:'hi'}],'test','mock');
  assert.equal(calls.at(-1)?.maxTokens,2000);
});

test('预算接口鉴权、部分更新、持久化、非法输入及写盘失败的原子性',async()=>{
  const f=makeFixture({name:'budget-panel',expectedProvider:'default'},'private:1');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-token-budget-'));
  const deps:any={cfg:f.cfg,store:f.store,providers:f.providers,personas:(f.pipeline as any).personas,
    log:(f.pipeline as any).log,runtime:()=>({napcatConnected:false,selfId:0,nickname:'',uptimeMs:1,startedAt:1})};
  const file=path.join(dir,'app.yaml');
  fs.writeFileSync(file,'# keep comment\nllm:\n  tokenBudgets:\n    vision: 2048\n');
  f.cfg.llm.tokenBudgets.vision=2048;
  f.cfg.server.authToken='fixture-token';
  let failWrite=false;
  deps.updateSettings=(patch:Record<string,unknown>)=>{
    const validated=validateSettings(f.cfg,patch,[]);
    if(!validated.ok) throw Error(validated.error);
    if(failWrite) throw Error('synthetic disk failure');
    setConfigValues(file,validated.entries);
    for(const [keys,value] of validated.entries)assignPath(f.cfg as unknown as Record<string,unknown>,keys.join('.'),value);
    return validated.entries.length;
  };
  const server=createServer(deps),headers={'authorization':'Bearer fixture-token','content-type':'application/json'};
  const update=(budgets:unknown)=>server.app.request('/api/token-budgets',{method:'PATCH',headers,body:JSON.stringify({budgets})});
  try {
    assert.equal((await server.app.request('/api/token-budgets')).status,401);
    assert.equal((await server.app.request('/api/token-budgets',{method:'PATCH',body:'{}'})).status,401);
    const response=await update({chat:4096,sticker:3000});
    assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json() as any).changed,2);
    assert.equal(f.cfg.llm.tokenBudgets.chat,4096);assert.equal(f.cfg.llm.tokenBudgets.vision,2048);
    const persisted=AppConfigSchema.parse(parse(fs.readFileSync(file,'utf8')));
    assert.equal(persisted.llm.tokenBudgets.chat,4096);assert.equal(persisted.llm.tokenBudgets.sticker,3000);
    assert.ok(fs.readFileSync(file,'utf8').includes('# keep comment'));
    const before=fs.readFileSync(file,'utf8'),runtime=JSON.stringify(f.cfg.llm.tokenBudgets);
    for(const budgets of [{},[],{other:100},{chat:1.5},{chat:-1},{chat:131073},{chat:'4096'},{chat:8192,vision:-1}]){
      assert.equal((await update(budgets)).status,400,JSON.stringify(budgets));
      assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(JSON.stringify(f.cfg.llm.tokenBudgets),runtime);
    }
    failWrite=true;
    assert.equal((await update({chat:8192})).status,400);
    assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(JSON.stringify(f.cfg.llm.tokenBudgets),runtime);
    failWrite=false;
    assert.equal((await update({chat:0})).status,200);
    const state=await (await server.app.request('/api/token-budgets',{headers})).json() as any;
    assert.equal(state.budgets.chat,0);assert.equal(state.budgets.vision,2048);
    f.cfg.llm.generation.maxTokens=8192;
    f.cfg.llm.generation.summaryMaxTokens=4096;
    const settings=await (await server.app.request('/api/settings',{headers})).json() as any;
    assert.equal(settings.groups['Token 预算'].length,7);
    const budgetSettings=settings.groups['Token 预算'] as Array<{path:string;originalBudget:string;value:number}>;
    assert.match(budgetSettings.find(s=>s.path==='llm.tokenBudgets.chat')!.originalBudget,/8192.*人格/);
    assert.match(budgetSettings.find(s=>s.path==='llm.tokenBudgets.summary')!.originalBudget,/4096/);
    assert.match(budgetSettings.find(s=>s.path==='llm.tokenBudgets.vision')!.originalBudget,/500.*1200.*6000/);
    assert.match(budgetSettings.find(s=>s.path==='llm.tokenBudgets.sticker')!.originalBudget,/600/);
    assert.equal(budgetSettings.find(s=>s.path==='llm.tokenBudgets.chat')!.value,0);
  } finally {f.store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
