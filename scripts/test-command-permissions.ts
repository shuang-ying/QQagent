import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {parse,stringify} from 'yaml';
import {AppConfigSchema,COMMAND_IDS} from '../src/core/types.js';
import {COMMAND_DEFINITIONS,authorizeCommand,commandPermission,parseCommand} from '../src/pipeline/command-permissions.js';
import {CommandHandler} from '../src/pipeline/commands.js';
import {TriggerPolicy} from '../src/persona/trigger.js';
import {InboundAdmission} from '../src/pipeline/admission.js';
import {validateAccess} from '../src/config/settings.js';
import {setConfigValues} from '../src/config/writer.js';
import {createServer} from '../src/server/api.js';
import {makeFixture} from './helpers/chat-fixture.js';

for(const id of COMMAND_IDS)test(`${id}: 三种权限、别名与黑名单`,async()=>{
 const f=makeFixture({name:'commands',expectedProvider:'default'},'private:1');
 f.cfg.trigger.admins=[10001];f.cfg.trigger.allowUsers=[10002];f.cfg.trigger.denyUsers=[10004];
 const handler=new CommandHandler(f.cfg,f.store,(f.pipeline as any).personas,(f.pipeline as any).log);
 try{
  for(const permission of ['admin','all','whitelist'] as const){
   f.cfg.trigger.commandPermissions[id]=permission;
   for(const uid of [10001,10002,10003,10004]){
    const allowed=uid!==10004 && (permission==='all'||uid===10001||(permission==='whitelist'&&uid===10002));
    assert.equal(authorizeCommand(f.cfg.trigger,id,uid).allowed,allowed);
    for(const alias of COMMAND_DEFINITIONS.find(d=>d.id===id)!.aliases){
     assert.equal(parseCommand(alias.toUpperCase()+'\t参数')?.id,id);
     const r=await handler.tryHandle(alias,{scope:'private:'+uid,scopeType:'private',userId:uid,senderName:'test',isAdmin:uid===10001,canUseCommands:false,canSwitchPersona:false});
     assert.equal(r.handled,true);if(!allowed)assert.match(r.reply!,/仅限|黑名单/);else assert.doesNotMatch(r.reply!,/仅限.*使用|用户在黑名单/);
    }
   }
  }
  f.cfg.trigger.allowUsers=[];f.cfg.trigger.commandPermissions[id]='whitelist';assert.equal(authorizeCommand(f.cfg.trigger,id,10003).allowed,false);assert.equal(authorizeCommand(f.cfg.trigger,id,10001).allowed,true);
 }finally{f.store.close();}
});

test('旧配置保持默认权限，单条覆盖独立于旧开关',()=>{
 const c=AppConfigSchema.parse({trigger:{commandAdminOnly:true,personaAdminOnly:true}});
 for(const id of COMMAND_IDS)assert.equal(commandPermission(c.trigger,id),'admin');
 c.trigger.commandPermissions.help='all';assert.equal(commandPermission(c.trigger,'help'),'all');assert.equal(commandPermission(c.trigger,'memory'),'admin');
 assert.equal(AppConfigSchema.safeParse({trigger:{commandPermissions:{help:'bad'}}}).success,false);
 assert.equal(AppConfigSchema.safeParse({trigger:{commandPermissions:{reset:'all'}}}).success,false);
});

test('指令准入不受聊天用户白名单误拦截，黑名单、群白名单和去重有效',()=>{
 const f=makeFixture({name:'admission',expectedProvider:'default'},'private:1');
 try{
  f.cfg.trigger.allowUsers=[10002];f.cfg.trigger.denyUsers=[10004];f.cfg.trigger.group.enabledGroups=[123];
  const t=new TriggerPolicy(f.cfg.trigger,(f.pipeline as any).log);const a=new InboundAdmission(t);
  const msg={...f.msg,userId:10003,text:'/help',messageId:300};assert.equal(a.admit(msg).allowed,false);assert.equal(a.admit(msg,true).allowed,true);assert.equal(a.admit(msg,true).allowed,false);
  assert.equal(a.admit({...msg,userId:10004,messageId:301},true).allowed,false);
  assert.equal(a.admit({...msg,scope:'group:999',scopeType:'group',groupId:999,messageId:302},true).allowed,false);
  assert.equal(a.admit({...msg,scope:'group:123',scopeType:'group',groupId:123,messageId:303},true).allowed,true);
  assert.equal(parseCommand('/unknown'),null);assert.equal(parseCommand('你好 /help'),null);
 }finally{f.store.close();}
});

test('面板API校验、保存到YAML并重新加载生效，写失败不改变权限',async()=>{
 const f=makeFixture({name:'access',expectedProvider:'default'},'private:1');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-command-permissions-'));const file=path.join(dir,'app.yaml');
 f.cfg.trigger.admins=[10001];f.cfg.trigger.allowUsers=[10002];f.cfg.trigger.commandAdminOnly=true;
 fs.writeFileSync(file,'# retained comment\n'+stringify(f.cfg));let fail=false;
 const deps:any={cfg:f.cfg,store:f.store,providers:f.providers,personas:(f.pipeline as any).personas,log:(f.pipeline as any).log,runtime:()=>({}),updateAccess:(entries:Array<[string[],unknown]>)=>{if(fail)throw Error('write rejected');setConfigValues(file,entries);for(const [keys,value]of entries){let obj:any=f.cfg;for(const k of keys.slice(0,-1))obj=obj[k];obj[keys.at(-1)!]=value;}return entries.length;}};
 const {app}=createServer(deps);const post=(commands:unknown)=>app.request('/api/access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commands})});
 try{
  const initial=await (await app.request('/api/access')).json();assert.equal(initial.commands.length,13);assert.ok(initial.commands.every((c:any)=>c.value==='admin'));
  assert.equal((await post({help:'all',persona:'whitelist'})).status,200);
  const reloaded=AppConfigSchema.parse(parse(fs.readFileSync(file,'utf8')));assert.equal(reloaded.trigger.commandPermissions.help,'all');assert.equal(reloaded.trigger.commandPermissions.persona,'whitelist');assert.ok(fs.readFileSync(file,'utf8').startsWith('# retained comment'));
  assert.equal(authorizeCommand(f.cfg.trigger,'help',10003).allowed,true);assert.equal(authorizeCommand(f.cfg.trigger,'persona',10003).allowed,false);
  const before=fs.readFileSync(file,'utf8');assert.equal((await post({help:'invalid'})).status,400);assert.equal((await post({reset:'all'})).status,400);assert.equal((await post(['all'])).status,400);assert.equal(fs.readFileSync(file,'utf8'),before);
  fail=true;assert.equal((await post({help:'admin'})).status,400);assert.equal(f.cfg.trigger.commandPermissions.help,'all');assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal(validateAccess(f.cfg,{lists:{admins:[]},commands:{stats:'admin'}}).ok,false);
  assert.equal(validateAccess(f.cfg,{lists:{allowUsers:[10002]}}).ok,true);
 }finally{f.store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Web权限下拉框渲染和保存请求包含每条指令，沿用鉴权请求封装',async()=>{
 const html=fs.readFileSync('src/web/panel.html','utf8');const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
 const defs=COMMAND_DEFINITIONS.map(d=>({...d,value:'admin'}));const els:Record<string,any>={commandPermissions:{},accessSummary:{},accessLists:{},accessFlags:{},commandPermissionsSave:{}};
 for(const d of defs)els['cmdperm_'+d.id]={value:d.id==='help'?'all':'whitelist'};
 let sent:any;
 const ctx:any={window:{_access:{commands:defs}},$: (id:string)=>els[id],api:async()=>({commands:defs,lists:[],flags:[],summary:{}}),post:async(url:string,body:unknown)=>{sent={url,body};return {ok:true};},toast:()=>{},esc:(s:unknown)=>String(s)};
 vm.createContext(ctx);
 const load=/async function loadAccess\(\) \{[\s\S]*?\n\}\n/.exec(script)![0];
 const save=/window.saveCommandPermissions = async \(\) => \{[\s\S]*?\n\};/.exec(script)![0];
 vm.runInContext(load+'\n'+save,ctx);await ctx.loadAccess();assert.match(els.commandPermissions.innerHTML,/管理员/);assert.match(els.commandPermissions.innerHTML,/白名单和管理员/);for(const d of defs)assert.ok(els.commandPermissions.innerHTML.includes('cmdperm_'+d.id));
 await ctx.window.saveCommandPermissions();assert.equal(sent.url,'/api/access');assert.equal(Object.keys(sent.body.commands).length,13);assert.equal(sent.body.commands.help,'all');assert.equal(els.commandPermissionsSave.disabled,false);
});
