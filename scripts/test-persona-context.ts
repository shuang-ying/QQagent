import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import {DatabaseSync} from 'node:sqlite';
import {PersonaSchema,contentToText} from '../src/core/types.js';import {makeFixture} from './helpers/chat-fixture.js';import {personaDefinition,personaFingerprint} from '../src/persona/definition.js';import {ContextBuilder,buildSummaryUserPrompt} from '../src/context/compressor.js';import {MemoryStore} from '../src/memory/store.js';import {createServer} from '../src/server/api.js';import {CommandHandler} from '../src/pipeline/commands.js';import {writePersona,loadPersonasFromDir} from '../src/persona/files.js';import {validatePersona} from '../src/config/settings.js';
function fixture(){const f=makeFixture({name:'persona',expectedProvider:'default'},'private:1');const manager=(f.pipeline as any).personas;const old=manager.get('test');const next=PersonaSchema.parse({id:'next',name:'新的助手',structured:{identity:'我是新的助手',speakingStyle:'清晰简短'},systemPrompt:''});manager.reload([old,next]);f.store.touchSession(f.msg.scope,'private',1,'test');return {...f,manager,old,next,log:(f.pipeline as any).log};}

test('旧人格兼容和结构化字段拼装，结构化单独使用及非法空设定校验',()=>{
 const p=PersonaSchema.parse({id:'old',name:'旧',systemPrompt:'原样保留的设定'});assert.equal(personaDefinition(p),'原样保留的设定');
 const next=PersonaSchema.parse({id:'next',name:'新',structured:{identity:'角色身份',answerPrinciples:'不知道就说不知道'}});assert.match(personaDefinition(next),/【身份】\n角色身份/);assert.match(personaDefinition(next),/回答原则/);assert.equal(validatePersona(next).ok,true);assert.equal(validatePersona({id:'blank',name:'空'}).ok,false);assert.notEqual(personaFingerprint(p),personaFingerprint({...p,systemPrompt:'另一个设定'}));
});

test('保留历史切换覆盖当前话题人格，原消息、记忆和话题不丢',()=>{
 const f=fixture();try{const old=f.store.currentConversationId(f.msg.scope);f.store.setConversationPersona(old,'test');f.store.addMessage({scope:f.msg.scope,userId:1,role:'user',content:'用户事实'});f.store.addFact({scope:f.msg.scope,userId:1,factType:'preference',content:'喜欢可乐'});
 const id=f.manager.switchForSession(f.msg.scope,'next','keep');assert.equal(id,old);assert.equal(f.manager.resolve(f.msg.scope,1).persona.id,'next');assert.equal(f.store.getConversationMessages(old).length,1);assert.equal(f.store.getFactsByUser(1).length,1);
 }finally{f.store.close();}
});

test('新开话题保留旧人格及历史，切回旧话题恢复旧人格',()=>{
 const f=fixture();try{const old=f.store.currentConversationId(f.msg.scope);f.store.addMessage({scope:f.msg.scope,userId:1,role:'user',content:'旧话题独有内容'});const id=f.manager.switchForSession(f.msg.scope,'next','new');assert.notEqual(id,old);assert.equal(f.store.getConversation(old)?.persona_id,'test');assert.equal(f.store.getConversationMessages(id).length,0);assert.equal(f.manager.resolve(f.msg.scope,1).persona.id,'next');assert.equal(f.store.getConversationMessages(old)[0]?.content,'旧话题独有内容');f.store.switchConversation(f.msg.scope,old);assert.equal(f.manager.resolve(f.msg.scope,1).persona.id,'test');}finally{f.store.close();}
});

test('切换事务失败回滚会话和话题人格，不通知取消',()=>{
 const f=fixture();try{const old=f.store.currentConversationId(f.msg.scope);const before=f.store.getSession(f.msg.scope)?.persona_id;let changed=0;f.store.onConversationChange(()=>changed++);f.store.db.exec("CREATE TRIGGER reject_switch BEFORE UPDATE OF persona_id ON conversations BEGIN SELECT RAISE(ABORT,'reject'); END;");assert.throws(()=>f.manager.switchForSession(f.msg.scope,'next','keep'),/reject/);assert.equal(f.store.getSession(f.msg.scope)?.persona_id,before);assert.equal(f.store.currentConversationId(f.msg.scope),old);assert.equal(changed,0);}finally{f.store.close();}
});

for(const mode of ['keep','new'] as const)test(`生成中${mode}切换取消旧回复，新轮次使用新人格`,async()=>{
 const f=fixture();let enter!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>enter=r),blocked=new Promise<void>(r=>release=r);let signal:AbortSignal|undefined;
 try{const original=f.providers.streamChat;f.providers.streamChat=async(...args)=>{signal=args[4]?.signal;enter();await blocked;return original(...args);};const task=f.pipeline.handle(f.msg,f.api);await ready;f.manager.switchForSession(f.msg.scope,'next',mode);assert.equal(signal?.aborted,true);release();assert.equal((await task).replied,false);assert.equal(f.sends(),0);f.providers.streamChat=original;assert.equal((await f.pipeline.handle({...f.msg,messageId:502},f.api)).personaId,'next');}finally{f.store.close();}
});

test('旧人格/旧版本/未知来源回复作为资料，同版回复仍为assistant，预算计算包含标记',()=>{
 const f=fixture();try{const fp=personaFingerprint(f.next);for(const [content,id,version]of [['旧口吻','test','old'],['旧版本','next','old'],['同版本','next',fp],['未知历史',undefined,undefined]] as const)f.store.addMessage({scope:f.msg.scope,userId:0,role:'assistant',content,personaId:id,personaFingerprint:version});
 const result=new ContextBuilder(f.cfg.context,f.cfg.memory,f.store,f.log).build({scope:f.msg.scope,userId:1,systemPrompt:f.manager.buildSystemPrompt({persona:f.next}),userMessage:'继续',contextWindow:32768,currentPersona:{id:'next',fingerprint:fp}});
 for(const text of ['旧口吻','旧版本','未知历史']){const item=result.messages.find(m=>contentToText(m.content).includes(text))!;assert.equal(item.role,'user');assert.match(contentToText(item.content),/历史机器人回复资料/);}
 assert.equal(result.messages.find(m=>m.content==='同版本')?.role,'assistant');assert.ok(result.stats.totalTokens<=result.stats.budget);const summary=buildSummaryUserPrompt(f.store.getRecentMessages(f.msg.scope,20));assert.match(summary,/历史人格：test/);assert.match(summary,/历史人格：未知/);
 }finally{f.store.close();}
});

test('确认投递的回复记录人格及内容指纹，原用户消息不被标成人格消息',async()=>{
 const f=fixture();try{await f.pipeline.handle(f.msg,f.api);const rows=f.store.getRecentMessages(f.msg.scope,20);const assistant=rows.find(r=>r.role==='assistant')!;assert.equal(assistant.persona_id,'test');assert.equal(assistant.persona_fingerprint,personaFingerprint(f.old));assert.equal(rows.find(r=>r.role==='user')?.persona_id,null);}finally{f.store.close();}
});

test('v3迁移备份并保留旧消息，未知人格不臆造归属',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'persona-migration-'));const file=path.join(dir,'brain.db');try{let store=new MemoryStore(file);store.touchSession('private:1','private',1,'test');store.addMessage({scope:'private:1',userId:0,role:'assistant',content:'旧消息'});store.close();const db=new DatabaseSync(file);db.exec("ALTER TABLE messages DROP COLUMN persona_id; ALTER TABLE messages DROP COLUMN persona_fingerprint; UPDATE meta SET value='3' WHERE key='schema_version';");db.close();store=new MemoryStore(file);assert.equal((store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as any).value,'4');assert.equal(store.getRecentMessages('private:1',10)[0]?.content,'旧消息');assert.equal(store.getRecentMessages('private:1',10)[0]?.persona_id,null);store.close();assert.ok(fs.readdirSync(dir).some(n=>n.includes('pre-v4')));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('API结构化保存、读回及切换模式，非法模式/范围不改状态',async()=>{
 const f=fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'persona-files-'));writePersona(dir,f.old);writePersona(dir,f.next);
 const deps:any={cfg:f.cfg,store:f.store,providers:f.providers,personas:f.manager,log:f.log,runtime:()=>({}),savePersona:(p:any)=>{writePersona(dir,p);f.manager.reload(loadPersonasFromDir(dir));}};const {app}=createServer(deps);
 const post=(url:string,body:any)=>app.request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{const r=await post('/api/personas/next/update',{persona:{...f.next,structured:{...f.next.structured,interactionStyle:'先认真倾听'}}});assert.equal(r.status,200);const list=await (await app.request('/api/personas')).json();assert.equal(list.personas.find((p:any)=>p.id==='next').structured.interactionStyle,'先认真倾听');assert.equal(loadPersonasFromDir(dir).find(p=>p.id==='next')?.structured.interactionStyle,'先认真倾听');
 const old=f.store.currentConversationId(f.msg.scope);assert.equal((await post('/api/personas/scope',{scope:f.msg.scope,personaId:'next',history:'bad'})).status,400);assert.equal(f.store.currentConversationId(f.msg.scope),old);assert.equal((await post('/api/personas/scope',{scope:'bad',personaId:'next'})).status,400);const next=await (await post('/api/personas/scope',{scope:f.msg.scope,personaId:'next',history:'new'})).json();assert.equal(next.ok,true);assert.notEqual(next.conversationId,old);const scope=await (await app.request('/api/personas/scope')).json();assert.equal(scope.sessions[0].personaId,'next');
 }finally{f.store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('QQ命令支持keep/new且非法参数不切换',async()=>{
 const f=fixture();const handler=new CommandHandler(f.cfg,f.store,f.manager,f.log);const ctx={scope:f.msg.scope,scopeType:'private' as const,userId:1,senderName:'test',isAdmin:false,canUseCommands:true,canSwitchPersona:true};try{const old=f.store.currentConversationId(f.msg.scope);let r=await handler.tryHandle('/persona next nonsense',ctx);assert.match(r.reply!,/用法/);assert.equal(f.store.currentConversationId(f.msg.scope),old);r=await handler.tryHandle('/人格 next keep',ctx);assert.match(r.reply!,/历史保留/);assert.equal(f.store.currentConversationId(f.msg.scope),old);r=await handler.tryHandle('/persona test new',ctx);assert.match(r.reply!,/新开话题/);assert.notEqual(f.store.currentConversationId(f.msg.scope),old);}finally{f.store.close();}
});

test('Web编辑器结构化字段及切换请求携带history选项',async()=>{
 const html=fs.readFileSync('src/web/panel.html','utf8');const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');new vm.Script(script);for(const key of ['identity','speakingStyle','interactionStyle','answerPrinciples','emotionalStyle'])assert.ok(html.includes('id="pf_'+key+'"'));assert.match(html,/保留历史（旧回复作为资料）/);assert.match(html,/新开话题（旧话题保留）/);let sent:any;const ctx:any={window:{},post:async(url:string,body:unknown)=>{sent={url,body};return {ok:true};},toast:()=>{},loadPersonas:async()=>{}};vm.createContext(ctx);vm.runInContext(/window.setScopePersona = async[\s\S]*?\n\};/.exec(script)![0],ctx);await ctx.window.setScopePersona('private:1','next','new');assert.equal(sent.body.history,'new');assert.equal(sent.url,'/api/personas/scope');
 const elements:Record<string,any>={};for(const name of ['originalId','id','name','emoji','desc','prompt','examples','emotion','keywords','pokereplies','errmsg','temp','maxTokens','identity','speakingStyle','interactionStyle','answerPrinciples','emotionalStyle','proactiveTopics'])elements['pf_'+name]={value:''};
 elements.pf_originalId.value='next';elements.pf_name.value='新角色';elements.pf_identity.value='结构化身份';elements.pf_saveBtn={};elements.pf_error={};
 ctx.$=(id:string)=>elements[id];ctx.esc=String;ctx.closePersonaEditor=()=>{};
 for(const name of ['parseExamples','parseEmotionModulation'])vm.runInContext(new RegExp('function '+name+'\\(text\\) \\{[\\s\\S]*?\\n\\}').exec(script)![0],ctx);
 vm.runInContext(/window.savePersona = async[\s\S]*?\n\};/.exec(script)![0],ctx);await ctx.window.savePersona();assert.equal(sent.url,'/api/personas/next/update');assert.equal(sent.body.persona.structured.identity,'结构化身份');assert.equal(sent.body.persona.systemPrompt,'');
 const previous=sent;elements.pf_identity.value='';await ctx.window.savePersona();assert.equal(sent,previous);assert.match(elements.pf_error.innerHTML,/结构化设定/);
});
