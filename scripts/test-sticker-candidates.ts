import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pino from 'pino';
import { StickerLibrary, canonicalEmotion, extractStickerTags, pickByLabel, requestsSticker, type StickerView } from '../src/persona/stickers.js';
import {ReplyDispatcher} from '../src/pipeline/dispatch.js';
import {ReplyBehaviorSchema, type ObMessageSegment} from '../src/core/types.js';
import {OneBotActionError, type OneBotAction} from '../src/onebot/action.js';
import {pathToFileURL} from 'node:url';
import { makeFixture } from './helpers/chat-fixture.js';
import sharp from 'sharp';
import { analyzeStickers } from '../src/persona/stickerAnalyze.js';
import { importQqFavorites } from '../src/persona/stickerImport.js';
import type { ProviderManager } from '../src/llm/manager.js';
import type { ChatMessage } from '../src/core/types.js';

test('收藏自带描述但无标签仍待识别，GIF识图转PNG而原图保持不变', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-sticker-lifecycle-'));
  try {
    await fs.mkdir(path.join(dir, 'qq'));
    const bytes = await sharp({create:{width:2,height:2,channels:3,background:'red'}}).gif().toBuffer();
    await fs.writeFile(path.join(dir, 'qq/cat.gif'), bytes);
    const lib = new StickerLibrary(dir, pino({level:'silent'}));
    lib.upsert([{file:'qq/cat.gif',tags:[],desc:'收藏原始描述',useWhen:'',emotions:[],source:'qq'}]);
    assert.equal(lib.pending().length, 1);
    assert.equal(lib.understood().length, 0);
    let calls = 0;
    const providers = {
      resolveRole: () => ({provider:'test',model:'vision'}),
      chat: async (messages: ChatMessage[]) => {
        calls++;
        const parts = messages[0]!.content;
        assert.ok(Array.isArray(parts));
        const image = parts.find(p => p.type === 'image');
        assert.ok(image?.type === 'image');
        assert.equal(image.mimeType, 'image/png');
        const meta = await sharp(Buffer.from(image.data!, 'base64')).metadata();
        assert.equal(meta.format, 'png');
        return {content:'{"tags":["cute"],"desc":"红色小猫","useWhen":"撒娇时","emotions":["love"]}'};
      },
    } as unknown as ProviderManager;
    const result = await analyzeStickers(providers, lib, pino({level:'silent'}));
    assert.equal(result.ok, 1);
    assert.equal(lib.pending().length, 0);
    assert.equal(lib.understood().length, 1);
    assert.equal((await analyzeStickers(providers, lib, pino({level:'silent'}))).skipped, 1);
    assert.equal(calls, 1);
    assert.deepEqual(await fs.readFile(path.join(dir, 'qq/cat.gif')), bytes);
  } finally { await fs.rm(dir, {recursive:true,force:true}); }
});

for (const content of ['{}', '{"tags":[],"desc":"一只猫"}', '{"tags":["cute"],"desc":{}}'])
test('不完整识图结果保留待识别状态：' + content, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-sticker-invalid-'));
  try {
    await fs.mkdir(path.join(dir, 'qq'));
    await fs.writeFile(path.join(dir, 'qq/cat.png'), await sharp({create:{width:1,height:1,channels:3,background:'red'}}).png().toBuffer());
    const lib = new StickerLibrary(dir, pino({level:'silent'}));
    const providers = {resolveRole:()=>({provider:'test',model:'vision'}),chat:async()=>({content})} as unknown as ProviderManager;
    const result = await analyzeStickers(providers, lib, pino({level:'silent'}));
    assert.equal(result.failed, 1);
    assert.equal(result.ok, 0);
    assert.equal(lib.pending().length, 1);
    assert.equal(lib.get('qq/cat.png')?.analyzedAt, undefined);
  } finally { await fs.rm(dir, {recursive:true,force:true}); }
});

test('重新导入修复缺失文件并保留AI理解，下载按真实格式命名且拒绝HTML', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-sticker-reimport-'));
  const originalFetch = globalThis.fetch;
  try {
    const bytes = await sharp({create:{width:1,height:1,channels:3,background:'red'}}).png().toBuffer();
    globalThis.fetch = (async (url: string) => new Response(url.includes('bad') ? '<html>expired</html>' : bytes)) as typeof fetch;
    const lib = new StickerLibrary(dir, pino({level:'silent'}));
    lib.upsert([{file:'qq/old.gif',tags:['cute'],desc:'猫咪卖萌',useWhen:'撒娇',emotions:['love'],source:'qq',md5:'abc123',resId:'old',analyzedAt:123}]);
    const items = [
      {url:'https://fixture/old',md5:'abc123',resId:'old',emojiId:'',desc:'QQ描述'},
      {url:'https://fixture/new.gif',md5:'def456',resId:'new',emojiId:'',desc:''},
      {url:'https://fixture/bad.png',md5:'bad789',resId:'bad',emojiId:'',desc:''},
    ];
    const api = {fetchCustomFaceDetail:async()=>items};
    const result = await importQqFavorites(api, lib, pino({level:'silent'}));
    assert.equal(result.added, 2);
    assert.equal(result.failed, 1);
    assert.deepEqual(await fs.readFile(path.join(dir, 'qq/old.gif')), bytes);
    assert.equal(lib.get('qq/old.gif')?.missing, false);
    assert.equal(lib.get('qq/old.gif')?.desc, '猫咪卖萌');
    assert.deepEqual(lib.get('qq/old.gif')?.tags, ['cute']);
    assert.equal(lib.get('qq/old.gif')?.analyzedAt, 123);
    assert.ok(lib.get('qq/qq_def456.png'));
    const repeated = await importQqFavorites({fetchCustomFaceDetail:async()=>items.slice(0,2)}, lib, pino({level:'silent'}));
    assert.equal(repeated.skipped, 2);
    assert.equal(repeated.added, 0);
  } finally { globalThis.fetch = originalFetch; await fs.rm(dir, {recursive:true,force:true}); }
});

test('开启自动发送且命中情绪留空时允许任何情绪，旧列表不限制空列表', () => {
  const f = makeFixture({name:'any-emotion',expectedProvider:'default'}, 'private:1');
  try {
    Object.assign(f.cfg.sticker.autoSend, {enabled:true, emotions:[], minIntensity:0, probability:1, cooldownSec:0});
    f.cfg.sticker.autoOnEmotions = ['sadness'];
    for (const label of ['joy','sadness','anger','neutral','surprise'])
      assert.equal((f.pipeline as any).shouldAutoSendSticker('private:1',{label,intensity:0.5}),true,label);
  } finally { f.store.close(); }
});

test('非空命中情绪保留指定匹配、别名和旧列表兼容，关闭空列表不自动开启', () => {
  const f = makeFixture({name:'selected-emotion',expectedProvider:'default'}, 'private:1');
  try {
    Object.assign(f.cfg.sticker.autoSend, {enabled:true, emotions:['happy'], minIntensity:0, probability:1, cooldownSec:0});
    f.cfg.sticker.autoOnEmotions = ['sad'];
    const allowed = (label:string) => (f.pipeline as any).shouldAutoSendSticker('private:1',{label,intensity:0.5});
    assert.equal(allowed('joy'),true); assert.equal(allowed('sadness'),true); assert.equal(allowed('neutral'),false);
    f.cfg.sticker.autoSend.enabled = false;
    f.cfg.sticker.autoSend.emotions = [];
    assert.equal(allowed('sadness'),true); assert.equal(allowed('neutral'),false);
    f.cfg.sticker.autoOnEmotions = [];
    assert.equal(allowed('joy'),false); assert.equal(allowed('neutral'),false);
  } finally { f.store.close(); }
});

test('任何情绪仍受最低强度、概率和会话冷却限制', () => {
  const f = makeFixture({name:'any-emotion-gates',expectedProvider:'default'}, 'private:1');
  try {
    Object.assign(f.cfg.sticker.autoSend, {enabled:true, emotions:[], minIntensity:0.5, probability:1, cooldownSec:0});
    const allowed = (intensity:number) => (f.pipeline as any).shouldAutoSendSticker('private:1',{label:'neutral',intensity});
    assert.equal(allowed(0.4),false); assert.equal(allowed(0.5),true);
    f.cfg.sticker.autoSend.probability = 0;
    assert.equal(allowed(0.9),false);
    f.cfg.sticker.autoSend.probability = 1;
    f.cfg.sticker.autoSend.cooldownSec = 30;
    (f.pipeline as any).lastStickerAt.set('private:1',Date.now());
    assert.equal(allowed(0.9),false);
    assert.equal((f.pipeline as any).shouldAutoSendSticker('private:2',{label:'neutral',intensity:0.9}),true);
    (f.pipeline as any).lastStickerAt.clear();
    f.store.db.prepare('INSERT INTO sticker_usage(scope,file,created_at) VALUES(?,?,?)').run('private:1','cat.png',Date.now());
    assert.equal(allowed(0.9),false);
  } finally { f.store.close(); }
});

test('80%概率只抽一次，固定1000个均匀样本准确命中800个', () => {
  const f = makeFixture({name:'sticker-probability',expectedProvider:'default'}, 'private:1');
  const originalRandom = Math.random;
  try {
    Object.assign(f.cfg.sticker.autoSend, {enabled:true,emotions:[],minIntensity:0,probability:0.8,cooldownSec:0});
    let calls = 0, selected = 0;
    Math.random = () => calls++ / 1000;
    for (let i = 0; i < 1000; i++) {
      if ((f.pipeline as any).shouldAutoSendSticker('private:1',{label:'neutral',intensity:0.9})) selected++;
    }
    assert.equal(calls, 1000);
    assert.equal(selected, 800);
    assert.equal(f.logs.filter(l => l.msg === '自动表情包概率判定').length, 1000);
  } finally { Math.random = originalRandom; f.store.close(); }
});

for (const mode of ['marker-zero','marker-hit','marker-miss','marker-cooldown','reply-context','emotion-fallback','explicit','no-emotion'] as const)
test('统一表情概率与候选补选：' + mode, async () => {
  const f = makeFixture({name:'sticker-probability-'+mode,expectedProvider:'default'}, 'private:1');
  const originalRandom = Math.random;
  try {
    f.cfg.sticker.enabled = true;
    f.cfg.sticker.maxPerReply = 1;
    f.cfg.emotion.enabled = mode !== 'no-emotion';
    Object.assign(f.cfg.sticker.autoSend, {enabled:true,emotions:[],minIntensity:0.3,probability:mode==='marker-zero'||mode==='explicit'?0:0.8,cooldownSec:mode==='marker-cooldown'?30:0,requireDesc:true});
    Math.random = () => mode === 'marker-miss' ? 0.8 : 0.799;
    (f.pipeline as any).emotion.snapshot = () => ({analyze:async()=>({label:'joy',intensity:0.9,valence:0.5,arousal:0.5,dominance:0.5,confidence:1})});
    const entry = {file:'happy.png',absPath:'synthetic-happy',tags:['happy'],desc:'开心举杯',useWhen:'庆祝',emotions:['joy'],missing:false};
    Object.assign(f.pipeline as any,{stickers:{available:true,
      candidates:(context:string)=>mode==='emotion-fallback'?[]:mode==='reply-context'&&!context.includes('庆祝')?[]:[entry],
      describeCandidatesForPrompt:()=> 'happy:开心举杯',list:()=>[entry]}});
    const sent: string[] = [];
    (f.pipeline as any).dispatcher.snapshot = () => ({thinkDelay:async()=>0,
      send:async()=>({state:'success',pieces:[{state:'success',content:'回复',messageId:1}]}),
      sendSticker:async(_api:unknown,_scope:string,file:string)=>{sent.push(file);return true;}});
    f.providers.streamChat = async () => ({content:mode.startsWith('marker')?'很开心 [表情:happy]':mode==='reply-context'?'一起庆祝吧':'很开心',model:'m',provider:'p',latencyMs:1,usage:{promptTokens:1,completionTokens:1,totalTokens:2}});
    if (mode==='marker-cooldown') (f.pipeline as any).lastStickerAt.set('private:1', Date.now());
    const text = mode==='explicit'?'发个表情包':'聊聊今天';
    const result = await f.pipeline.handle({...f.msg,text,segments:[{type:'text',data:{text}}]}, f.api);
    assert.equal(result.replied, true, JSON.stringify(result));
    const expected = ['marker-hit','reply-context','emotion-fallback','explicit'].includes(mode);
    assert.equal(sent.length, expected?1:0);
    assert.equal(f.logs.filter(l => l.msg === '自动表情包概率判定').length,
      ['marker-cooldown','explicit','no-emotion'].includes(mode)?0:1);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM sticker_usage').get() as {n:number}).n, expected?1:0);
  } finally { Math.random = originalRandom; f.store.close(); }
});

for (const mode of ['any','selected','no-desc','no-candidates','off','limit-zero','prefer-emotion'] as const)
test('自动补图'+mode+'按本轮候选处理空情绪列表并保留限制', async () => {
  const f = makeFixture({name:'contextual-auto-sticker',expectedProvider:'default'}, 'private:1');
  try {
    f.cfg.emotion.enabled = true;
    f.cfg.sticker.enabled = mode !== 'off';
    f.cfg.sticker.maxPerReply = mode === 'limit-zero' ? 0 : 1;
    Object.assign(f.cfg.sticker.autoSend, {enabled:true, emotions:mode === 'selected' ? ['joy'] : [], minIntensity:0, probability:1, cooldownSec:0, requireDesc:true});
    (f.pipeline as any).emotion.snapshot = () => ({analyze:async()=>({label:'neutral',intensity:0.9,valence:0,arousal:0.3,dominance:0.5,confidence:1})});
    const contextual = {file:'database.png',absPath:'synthetic-contextual',tags:['database'],desc:mode==='no-desc'?'':'数据库讨论',useWhen:'讨论数据库',emotions:['joy']};
    const neutral = {...contextual,file:'neutral.png',absPath:'synthetic-neutral',emotions:['neutral']};
    const candidates = mode === 'no-candidates' ? [] : mode === 'prefer-emotion' ? [contextual,neutral] : [contextual];
    // 六张提示词候选为空时，仍可从库中选出匹配本轮情绪的已理解图片。
    Object.assign(f.pipeline as any,{stickers:{available:true,candidates:()=>candidates,describeCandidatesForPrompt:()=>'',list:()=>[contextual,neutral]}});
    const sent:string[] = [];
    (f.pipeline as any).dispatcher.snapshot = () => ({thinkDelay:async()=>0,
      send:async()=>({state:'success',pieces:[{state:'success',content:'回复',messageId:1}]}),
      sendSticker:async(_api:unknown,_scope:string,file:string)=>{sent.push(file);return true;}});
    const text = '讨论数据库';
    const result = await f.pipeline.handle({...f.msg,text,segments:[{type:'text',data:{text}}]},f.api);
    assert.equal(result.replied,true,JSON.stringify({result,errors:f.logs.filter(l=>Number(l.level)>=40)}));
    assert.deepEqual(sent,mode==='any'?['synthetic-contextual']:mode==='prefer-emotion'||mode==='no-candidates'?['synthetic-neutral']:[]);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM sticker_usage').get() as {n:number}).n,sent.length);
  } finally { f.store.close(); }
});
test('语境匹配、情绪别名和冷却排除，无匹配不随机', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-sticker-'));
  try {
    for (const file of ['happy_1.png', 'sad_1.png']) await fs.writeFile(path.join(dir, file), Buffer.from('fixture'));
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ entries: [
      { file: 'happy_1.png', tags: ['happy'], desc: '开心举杯', useWhen: '考试通过庆祝', emotions: ['happy'] },
      { file: 'sad_1.png', tags: ['sad'], desc: '难过哭泣', useWhen: '失落安慰', emotions: ['sad'] },
    ] }));
    const lib = new StickerLibrary(dir, pino({ level: 'silent' }));
    assert.equal(canonicalEmotion('happy'), 'joy'); assert.equal(lib.candidates('考试通过', 'neutral')[0]?.file, 'happy_1.png');
    assert.equal(lib.pickByEmotion('anger'), undefined); assert.equal(lib.candidates('讨论数据库', 'neutral').length, 0);
    assert.equal(lib.candidates('', 'joy', 5, { excludedFiles: ['happy_1.png'] }).length, 0);
    assert.equal(lib.describeCandidatesForPrompt(lib.candidates('', 'joy')).includes('sad'), false);
  } finally { for (const file of ['happy_1.png', 'sad_1.png', 'manifest.json']) await fs.unlink(path.join(dir, file)); await fs.rmdir(dir); }
});

test('仅明确的正向表情请求触发兜底，否定和排障不触发',()=>{
  for(const text of ['发个表情包','给我来个表情','给我一个开心的表情包','来一张猫咪的表情包'])assert.equal(requestsSticker(text),true,text);
  for(const text of ['不要发表情包','别给我表情包','如何发表情包','表情包怎么设置','为什么不发表情包','表情包好像发不出来','今天聊数据库','这张表情包真有趣'])assert.equal(requestsSticker(text),false,text);
});

test('明确请求可提供有描述候选，无请求不随机，冷却排除仍生效',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qq-sticker-request-'));
  try{
    await fs.writeFile(path.join(dir,'cat.png'),Buffer.from('fixture'));
    await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({entries:[{file:'cat.png',tags:['cat'],desc:'猫咪举杯',useWhen:'庆祝',emotions:[]}]}));
    const lib=new StickerLibrary(dir,pino({level:'silent'}));
    assert.equal(lib.candidates('来个表情包','neutral').length,0);
    assert.equal(lib.candidates('来个表情包','neutral',6,{requestFallback:true})[0]?.file,'cat.png');
    assert.equal(lib.candidates('来个表情包','neutral',6,{requestFallback:true,excludedFiles:['cat.png']}).length,0);
  }finally{for(const file of ['cat.png','manifest.json'])await fs.unlink(path.join(dir,file));await fs.rmdir(dir);}
});

for(const mode of ['request','negative','off','limit-zero','forward'] as const)test('模型没加表情标记时'+mode+'尊重明确请求、开关及资料来源',async()=>{
  const f=makeFixture({name:'explicit-sticker',expectedProvider:'default'},'private:1');
  try{
    f.cfg.sticker.enabled=mode!=='off';f.cfg.sticker.maxPerReply=mode==='limit-zero'?0:1;
    const entry={file:'cat.png',absPath:'synthetic',tags:['cat'],desc:'猫咪举杯',useWhen:'庆祝',emotions:[]};
    let stickerSends=0;
    Object.assign(f.pipeline as any,{stickers:{available:true,candidates:()=>[entry],describeCandidatesForPrompt:()=> 'cat:猫咪举杯',list:()=>[entry]}});
    (f.pipeline as any).dispatcher.snapshot=()=>({thinkDelay:async()=>0,send:async()=>({state:'success',pieces:[{state:'success',content:'回复',messageId:1}]}),sendSticker:async()=>{stickerSends++;return true;}});
    const text=mode==='negative'?'不要发表情包':'发个表情包';
    const result=await f.pipeline.handle({...f.msg,text,segments:[{type:mode==='forward'?'forward_content':'text',data:{text}}]},f.api);
    assert.equal(result.replied,true);assert.equal(stickerSends,mode==='request'?1:0);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM sticker_usage').get() as {n:number}).n,mode==='request'?1:0);
  }finally{f.store.close();}
});

for(const outcome of ['success','known-failure','unknown','missing-id','cancelled'] as const)test('表情投递'+outcome+'使用标准URI、确认回执且不盲目重发',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qq-sticker-wire-')),file=path.join(dir,'表 情包.png'),bytes=Buffer.from('image-fixture');
  const controller=new AbortController();if(outcome==='cancelled')controller.abort();
  const payloads:ObMessageSegment[][]=[],logs:Array<Record<string,unknown>>=[];
  const log=pino({level:'debug'},{write:(line:string)=>logs.push(JSON.parse(line))});
  try{
    await fs.writeFile(file,bytes);
    const api={sendToScope:async(_scope:string,message:ObMessageSegment[])=>{
      payloads.push(message);
      if(outcome==='unknown')throw new OneBotActionError('send','failed',-1,'timeout','unknown');
      if(outcome==='known-failure'&&payloads.length===1)throw new OneBotActionError('send','failed',1400,'URI未支持','failed');
      if(outcome==='missing-id')return {};
      return {message_id:-5};
    }} as unknown as OneBotAction;
    const result=await new ReplyDispatcher(ReplyBehaviorSchema.parse({}),log).sendSticker(api,'group:123',file,{signal:controller.signal});
    assert.equal(result,outcome==='success'||outcome==='known-failure');
    assert.equal(payloads.length,outcome==='cancelled'?0:outcome==='known-failure'?2:1);
    if(payloads.length)assert.equal(payloads[0]![0]!.data.file,pathToFileURL(file).href);
    if(outcome==='known-failure')assert.equal(payloads[1]![0]!.data.file,'base64://'+bytes.toString('base64'));
    assert.equal(logs.some(l=>l.msg==='表情包已确认投递'),result);
    if(outcome==='unknown'||outcome==='missing-id')assert.ok(logs.some(l=>l.outcome==='unknown'));
  }finally{await fs.unlink(file);await fs.rmdir(dir);}
});

test('图片路径明确拒绝后任务被取消，不继续base64发送',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qq-sticker-cancel-')),file=path.join(dir,'cat.png'),controller=new AbortController();
  try{
    await fs.writeFile(file,Buffer.from('fixture'));let sends=0;
    const api={sendToScope:async()=>{sends++;controller.abort();throw new OneBotActionError('send','failed',1400,'URI未支持','failed');}} as unknown as OneBotAction;
    assert.equal(await new ReplyDispatcher(ReplyBehaviorSchema.parse({}),pino({level:'silent'})).sendSticker(api,'group:123',file,{signal:controller.signal}),false);
    assert.equal(sends,1);
  }finally{await fs.unlink(file);await fs.rmdir(dir);}
});
test('解析：标记变体都摘掉，普通方括号不误吞', () => {
  const cases: Array<[string, string, string[]]> = [
    ['正文 [表情:happy]', '正文', ['happy']],
    ['[表情包：胖乎乎的鱼翻肚皮]', '', ['胖乎乎的鱼翻肚皮']],
    ['[表情包:一只傲娇的蓝鱼甩着尾巴说“哼”]', '', ['一只傲娇的蓝鱼甩着尾巴说“哼']],
    ['[j表情:mocking]', '', ['mocking']],
    ['【表情:happy】', '', ['happy']],
    ['[表情: happy。]', '', ['happy']],
    ['[表情:happy sad]', '', ['happy sad']],
    ['[表情：开心]', '', ['开心']],
  ];
  for (const [input, text, tags] of cases) {
    const r = extractStickerTags(input);
    assert.equal(r.text, text, input);
    assert.deepEqual(r.tags, tags, input);
    assert.ok(r.markers > 0, input);
  }
  // 正常用语里的方括号不能被当成标记吃掉
  for (const keep of ['这表情管理正好凑一对', '数组[0] 是这样', '普通文本']) {
    const r = extractStickerTags(keep);
    assert.equal(r.text, keep);
    assert.deepEqual(r.tags, []);
    assert.equal(r.markers, 0);
  }
});

test('解析：候选优先、全库兜底、描述匹配、冷却排除', () => {
  const view = (file: string, tags: string[], desc = '', useWhen = ''): StickerView => ({
    file, tags, desc, useWhen, emotions: [], source: 'local',
    absPath: `/tmp/${file}`, size: 1, missing: false,
  });
  const pool = [view('a.png', ['database'], '数据库讨论', '讨论数据库')];
  const all = [...pool, view('pout.png', ['pout'], '嘟嘴生气', '撒娇'), view('fish.png', ['fish'], '胖鱼翻肚皮', '调侃')];

  // 候选里的精确标签优先
  assert.equal(pickByLabel('database', pool, { all })?.file, 'a.png');
  // 候选里没有、但库里有的标签也要能发（模型写对标签却静默丢弃是旧 bug）
  assert.equal(pickByLabel('pout', pool, { all })?.file, 'pout.png');
  assert.equal(pickByLabel('POUT', pool, { all })?.file, 'pout.png');
  // 描述型标记（[表情包:胖鱼翻肚皮]）按语境找
  assert.equal(pickByLabel('胖鱼翻肚皮', pool, { all })?.file, 'fish.png');
  // 冷却/已发过的图不能被点名复活；对不上任何一张时返回 undefined，交给调用方兜底
  assert.equal(pickByLabel('pout', pool, { all, excludedFiles: ['pout.png'] }), undefined);
  assert.equal(pickByLabel('完全不存在的标签xyz', pool, { all }), undefined);
  assert.equal(pickByLabel('', pool, { all }), undefined);
});

test('模型只返回描述型标记：不泄露方括号、图要发出去', async () => {
  const f = makeFixture({ name: 'sticker-marker-leak', expectedProvider: 'default' }, 'private:1');
  try {
    f.cfg.sticker.enabled = true;
    const contextual = { file: 'contextual.png', absPath: 'synthetic-contextual', tags: ['database'], desc: '数据库讨论', useWhen: '讨论数据库', emotions: ['neutral'] };
    const pout = { file: 'pout.png', absPath: 'synthetic-pout', tags: ['pout'], desc: '嘟嘴生气', useWhen: '撒娇', emotions: ['sadness'] };
    Object.assign(f.pipeline as any, { stickers: { available: true, candidates: () => [contextual], describeCandidatesForPrompt: () => '', list: () => [contextual, pout] } });
    const sent: string[] = [];
    (f.pipeline as any).dispatcher.snapshot = () => ({
      thinkDelay: async () => 0,
      send: async (_a: unknown, _c: unknown, text: string) => ({ state: 'success', pieces: [{ state: 'success', content: text, messageId: 1 }] }),
      sendSticker: async (_a: unknown, _s: string, file: string) => { sent.push(file); return true; },
    });

    // 1) 生产事故原文：模型写的是描述，不是标签 —— 以前这串方括号会当正文发到群里
    f.providers.streamChat = async () => ({ content: '[表情包：胖乎乎的鱼翻肚皮]', model: 'm', provider: 'p', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    const only = await f.pipeline.handle({ ...f.msg }, f.api);
    assert.equal(only.replied, true, JSON.stringify(only));
    assert.equal(only.content, '');
    assert.deepEqual(sent, ['synthetic-contextual']);

    // 2) 标签写对了但没进候选（库里 80 个标签、候选只有 6 张）：也要发出去，且正文不留标记
    sent.length = 0;
    f.providers.streamChat = async () => ({ content: '行吧，给你。[j表情:pout]', model: 'm', provider: 'p', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    const marked = await f.pipeline.handle({ ...f.msg, messageId: 11 }, f.api);
    assert.equal(marked.replied, true, JSON.stringify(marked));
    assert.equal(marked.content, '行吧，给你。');
    assert.deepEqual(sent, ['synthetic-pout']);
    const stored = f.store.db.prepare("SELECT content FROM messages WHERE role='assistant'").all() as Array<{ content: string }>;
    assert.equal(stored.some((m) => m.content.includes('[表情')), false, JSON.stringify(stored));
  } finally { f.store.close(); }
});

test('失败表情投递不消耗冷却，成功才落使用记录', async () => {
  for (const ok of [false, true]) {
    for (const body of ['回复', '']) {
    const f = makeFixture({ name: 'usage', expectedProvider: 'default' }, 'private:1');
    try {
      f.cfg.sticker.enabled = true;
      const entry = { file: 'happy.png', absPath: 'synthetic', tags: ['happy'], desc: '开心', useWhen: '开心', emotions: ['joy'] };
      Object.assign(f.pipeline as any, { stickers: { available: true, candidates: () => [entry], describeCandidatesForPrompt: () => 'happy', list: () => [entry] } });
      (f.pipeline as any).dispatcher.snapshot = () => ({ thinkDelay: async () => 0,
        send: async () => ({ state: 'success', pieces: [{ state: 'success', content: '回复', messageId: 1 }] }), sendSticker: async () => ok });
      f.providers.streamChat = async () => ({ content: `${body}[表情:happy]`, model: 'm', provider: 'p', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
      const result = await f.pipeline.handle(f.msg, f.api);
      if (!body) assert.equal(result.replied, ok);
      assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM sticker_usage').get() as { n: number }).n, ok ? 1 : 0);
    } finally { f.store.close(); }
    }
  }
});
