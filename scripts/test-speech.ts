import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { SpeechService, pcmToWav, audioType, speechTemplate } from '../src/llm/speech.js';
import { AppConfigSchema, PersonaSchema, contentToText } from '../src/core/types.js';
import vm from 'node:vm';
import { ProviderManager as RealProviderManager } from '../src/llm/manager.js';
import type { ProviderManager } from '../src/llm/manager.js';
import type { OneBotAction } from '../src/onebot/action.js';
import { makeFixture as rawFixture } from './helpers/chat-fixture.js';
import { validateSettings } from '../src/config/settings.js';
const makeFixture = (scenario: Parameters<typeof rawFixture>[0], scope = 'private:1') => rawFixture(scenario, scope);
const log = pino({ level: 'silent' }), wav = pcmToWav(Buffer.alloc(20));
async function setup(handler: (url: string, body: Buffer, headers: http.IncomingHttpHeaders, res: http.ServerResponse) => void) { const calls: Array<{
    url: string;
    body: Buffer;
    headers: http.IncomingHttpHeaders;
}> = []; const server = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on('data', b => chunks.push(b)); req.on('end', () => { const body = Buffer.concat(chunks), url = req.url!; calls.push({ url, body, headers: req.headers }); handler(url, body, req.headers, res); }); }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address() as {
    port: number;
}, root = 'http://127.0.0.1:' + address.port; const cfg = AppConfigSchema.parse({ llm: { defaultProvider: 'audio', roles: { asr: { model: 'asr-model' }, tts: { model: 'tts-model' } } } }); const provider = { enabled: true, protocol: 'openai', baseURL: root + '/v1', apiKey: 'test-key', headers: {} }; const providers = { getProvider: () => provider } as unknown as ProviderManager; const speech = new SpeechService(cfg, providers, log); return { cfg, provider, speech, calls, root, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) }; }
const persona = PersonaSchema.parse({ id: 'test', name: '测试', voice: { voice: 'custom-voice', speed: 1.2, instructions: '温柔地朗读' } });
test('OpenAI兼容ASR使用multipart，独立模型与认证正确', async () => { const f = await setup((_u, _b, _h, res) => res.end('{"text":"你好语音"}')); try {
    assert.equal(await f.speech.transcribe(wav), '你好语音');
    assert.equal(f.calls[0]!.url, '/v1/audio/transcriptions');
    assert.match(String(f.calls[0]!.headers['content-type']), /multipart/);
    assert.equal(f.calls[0]!.headers.authorization, 'Bearer test-key');
    assert.ok(f.calls[0]!.body.includes(Buffer.from('asr-model')));
}
finally {
    await f.close();
} });
test('人格TTS覆盖音色、语速和风格，返回有效音频', async () => { const f = await setup((_u, _b, _h, res) => res.end(wav)); try {
    audioType(await f.speech.synthesize('你好', persona));
    const body = JSON.parse(f.calls[0]!.body.toString());
    assert.equal(body.voice, 'custom-voice');
    assert.equal(body.speed, 1.2);
    assert.equal(body.instructions, '温柔地朗读');
    assert.equal(body.model, 'tts-model');
}
finally {
    await f.close();
} });
test('Gemini原生ASR发送inlineData与API Key，接收多个文字段', async () => { const f = await setup((_u, _b, _h, res) => res.end('{"candidates":[{"content":{"parts":[{"text":"你好"},{"text":"世界"}]}}]}')); try {
    f.cfg.speech.asr.protocol = 'gemini';
    assert.equal(await f.speech.transcribe(wav), '你好世界');
    assert.match(f.calls[0]!.url, /v1beta\/models\/asr-model:generateContent/);
    assert.equal(f.calls[0]!.headers['x-goog-api-key'], 'test-key');
    assert.equal(JSON.parse(f.calls[0]!.body.toString()).contents[0].parts[1].inlineData.mimeType, 'audio/wav');
}
finally {
    await f.close();
} });
test('Gemini原生TTS把PCM转换WAV且使用人格音色', async () => { const f = await setup((_u, _b, _h, res) => res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '额外文字' }, { inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(20).toString('base64') } }] } }] }))); try {
    f.cfg.speech.tts.protocol = 'gemini';
    const audio = await f.speech.synthesize('朗读', persona);
    assert.equal(audioType(audio).ext, 'wav');
    assert.equal(audio.readUInt32LE(24), 24000);
    assert.equal(JSON.parse(f.calls[0]!.body.toString()).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'custom-voice');
}
finally {
    await f.close();
} });
test('自定义ASR支持嵌套JSON模板、base64和响应点路径', async () => { const f = await setup((_u, _b, _h, res) => res.end('{"result":{"transcript":"自定义转写"}}')); try {
    Object.assign(f.cfg.speech.asr, { protocol: 'custom', encoding: 'base64-json', path: '/recognize', modelField: '', fileField: '', responsePath: 'result.transcript', extra: { request: { audio: '$audioBase64', engine: '$model', type: '$mimeType' } } });
    assert.equal(await f.speech.transcribe(wav), '自定义转写');
    const body = JSON.parse(f.calls[0]!.body.toString());
    assert.equal(body.request.audio, wav.toString('base64'));
    assert.equal(body.model, undefined);
    assert.equal(f.calls[0]!.url, '/v1/recognize');
}
finally {
    await f.close();
} });
test('自定义multipart ASR文件字段可以映射', async () => { const f = await setup((_u, _b, _h, res) => res.end('{"text":"成功"}')); try {
    Object.assign(f.cfg.speech.asr, { protocol: 'custom', fileField: 'recording', modelField: 'engine' });
    await f.speech.transcribe(wav);
    assert.match(f.calls[0]!.body.toString(), /name="recording"/);
    assert.match(f.calls[0]!.body.toString(), /name="engine"/);
}
finally {
    await f.close();
} });
test('自定义TTS支持嵌套请求和base64响应，空字段可省略', async () => { const f = await setup((_u, _b, _h, res) => res.end(JSON.stringify({ data: { audio: wav.toString('base64') } }))); try {
    Object.assign(f.cfg.speech.tts, { protocol: 'custom', responseType: 'base64', responsePath: 'data.audio', modelField: '', textField: '', voiceField: '', speedField: '', instructionsField: '', formatField: '', extra: { request: { text: '$text', voice: '$voice', speed: '$speed' } } });
    assert.equal((await f.speech.synthesize('文字', persona)).length, wav.length);
    const body = JSON.parse(f.calls[0]!.body.toString());
    assert.deepEqual(body, { request: { text: '文字', voice: 'custom-voice', speed: 1.2 } });
}
finally {
    await f.close();
} });
test('TTS可读取URL音频，下载不携带供应商密钥', async () => { let root = ''; const f = await setup((url, _b, h, res) => { if (url === '/audio') {
    assert.equal(h.authorization, undefined);
    res.end(wav);
}
else
    res.end(JSON.stringify({ audio: root + '/audio' })); }); root = f.root; try {
    Object.assign(f.cfg.speech.tts, { protocol: 'custom', responseType: 'url' });
    assert.equal((await f.speech.synthesize('文字', persona)).length, wav.length);
}
finally {
    await f.close();
} });
test('未配置语音模型不调用聊天模型，不请求服务', async () => { const f = await setup((_u, _b, _h, res) => res.end('{}')); try {
    f.cfg.llm.roles.asr.model = '';
    await assert.rejects(f.speech.transcribe(wav), /ASR模型/);
    assert.equal(f.calls.length, 0);
}
finally {
    await f.close();
} });
test('ASR空响应、TTS非音频和HTTP错误被识别', async () => { const f = await setup((_u, _b, _h, res) => res.end('{}')); try {
    await assert.rejects(f.speech.transcribe(wav), /未返回文字/);
    await assert.rejects(f.speech.synthesize('文字', persona), /音频格式/);
}
finally {
    await f.close();
} });
test('音频大小和朗读长度限制在调用前生效', async () => { const f = await setup((_u, _b, _h, res) => res.end(wav)); try {
    f.cfg.speech.maxBytes = 1024;
    await assert.rejects(f.speech.transcribe(pcmToWav(Buffer.alloc(2048))), /大小/);
    f.cfg.speech.tts.maxChars = 50;
    await assert.rejects(f.speech.synthesize('甲'.repeat(51), persona), /朗读长度/);
    assert.equal(f.calls.length, 0);
}
finally {
    await f.close();
} });
test('请求取消能中断慢语音接口', async () => { const f = await setup(() => { }); try {
    const controller = new AbortController(), pending = f.speech.transcribe(wav, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending);
}
finally {
    await f.close();
} });
test('OneBot get_record转换后的可信目录音频可以转写', async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-speech-')), file = path.join(dir, 'converted.wav'); fs.writeFileSync(file, wav); const f = await setup((_u, _b, _h, res) => res.end('{"text":"转换结果"}')); try {
    f.cfg.speech.allowedDirs = [dir];
    let get = 0;
    const api = { getRecord: async () => { get++; return { file }; } } as unknown as OneBotAction;
    const base = makeFixture({ name: 'audio', expectedProvider: 'default' });
    const msg = { ...base.msg, segments: [{ type: 'record', data: { file: 'opaque.silk' } }] };
    const result = await f.speech.transcribeInbound(msg, api);
    assert.equal(get, 1);
    assert.match(result.text, /转换结果/);
    base.store.close();
}
finally {
    await f.close();
    fs.rmSync(dir, { recursive: true, force: true });
} });
test('未授权本地目录拒绝读取，录音失败不猜测内容', async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-speech-denied-')), file = path.join(dir, 'converted.wav'); fs.writeFileSync(file, wav); const f = await setup((_u, _b, _h, res) => res.end('{"text":"不应出现"}')); const base = makeFixture({ name: 'audio', expectedProvider: 'default' }); try {
    const result = await f.speech.transcribeInbound({ ...base.msg, segments: [{ type: 'record', data: { file } }] }, { getRecord: async () => ({ file }) } as unknown as OneBotAction);
    assert.match(result.text, /未能转写/);
    assert.equal(f.calls.length, 0);
}
finally {
    base.store.close();
    await f.close();
    fs.rmSync(dir, { recursive: true, force: true });
} });
test('语音转写进入模型输入和原消息行，保留外层身份', async () => { const f = makeFixture({ name: 'audio-pipeline', expectedProvider: 'default' }); try {
    f.cfg.speech.asr.enabled = true;
    f.pipeline.attachSpeech({ transcribeInbound: async (msg: import('../src/core/types.js').InboundMessage) => ({ ...msg, text: '语音说我喜欢茶', segments: [{ type: 'speech_text', data: { text: '语音说我喜欢茶' } }] }), replyVoice: async () => false } as unknown as SpeechService);
    assert.equal((await f.pipeline.handle({ ...f.msg, text: '[语音]', segments: [{ type: 'record', data: { file: 'opaque' } }] }, f.api)).replied, true);
    assert.ok(f.calls[0]!.messages.some(m => contentToText(m.content).includes('语音说我喜欢茶')));
    assert.ok(f.store.getRecentMessages(f.msg.scope, 10).some(r => r.user_id === f.msg.userId && r.raw_segments?.includes('speech_text')));
}
finally {
    f.store.close();
} });
test('未@群语音默认不识别，黑名单语音不会调用接口', async () => { const f = makeFixture({ name: 'audio-gate', expectedProvider: 'default' }, 'group:123'); try {
    f.cfg.speech.asr.enabled = true;
    let calls = 0;
    f.pipeline.attachSpeech({ transcribeInbound: async (msg: import('../src/core/types.js').InboundMessage) => { calls++; return msg; } } as unknown as SpeechService);
    await f.pipeline.handle({ ...f.msg, messageId: 20, mentionsBot: false, text: '[语音]', segments: [{ type: 'record', data: { file: 'opaque' } }] }, f.api);
    f.cfg.trigger.denyUsers = [f.msg.userId];
    await f.pipeline.handle({ ...f.msg, messageId: 21, text: '[语音]', segments: [{ type: 'record', data: { file: 'opaque' } }] }, f.api);
    assert.equal(calls, 0);
}
finally {
    f.store.close();
} });
test('TTS失败仍保留已经投递的文字结果', async () => { const f = makeFixture({ name: 'voice-fallback', expectedProvider: 'default' }); try {
    f.cfg.speech.tts.enabled = true;
    f.pipeline.attachSpeech({ replyVoice: async () => false } as unknown as SpeechService);
    const r = await f.pipeline.handle(f.msg, f.api);
    assert.equal(r.replied, true);
    assert.equal(r.deliveryState, 'success');
    assert.ok(f.store.getRecentMessages(f.msg.scope, 10).some(row => row.role === 'assistant'));
}
finally {
    f.store.close();
} });
test('语音设置校验字段映射和JSON，不接受非法协议', () => { const cfg = AppConfigSchema.parse({}); assert.equal(validateSettings(cfg, { 'speech.asr.protocol': 'bad' }).ok, false); assert.equal(validateSettings(cfg, { 'speech.tts.extra': { request: { text: '$text' } }, 'speech.tts.textField': '' }).ok, true); assert.equal(validateSettings(cfg, { 'speech.tts.extra': '{}' }).ok, false); });
test('模板保留数字类型和嵌套，不执行代码', () => assert.deepEqual(speechTemplate({ a: ['$speed', '$text', '${process.env.KEY}'] }, { speed: 1.2, text: '你好' }), { a: [1.2, '你好', '${process.env.KEY}'] }));
test('人格语音实际投递、音频模式与人格开关正确', async () => { const f = await setup((_u, _b, _h, res) => res.end(wav)), base = makeFixture({ name: 'voice-send', expectedProvider: 'default' }); try {
    f.cfg.speech.tts.enabled = true;
    let sends = 0;
    const api = { canSendRecord: async () => ({ yes: true }), sendToScope: async (scope: string, segments: any) => { assert.equal(scope, base.msg.scope); assert.equal(segments[0].type, 'record'); assert.equal(segments[0].data.file, 'base64://' + wav.toString('base64')); sends++; return { message_id: 1 }; } } as unknown as OneBotAction;
    const signal = new AbortController().signal;
    assert.equal(await f.speech.replyVoice(api, base.msg, '你好', persona, signal, f.cfg, false), false);
    assert.equal(await f.speech.replyVoice(api, base.msg, '你好', { ...persona, voice: { ...persona.voice, enabled: false } }, signal, f.cfg, true), false);
    assert.equal(await f.speech.replyVoice(api, base.msg, '你好', persona, signal, f.cfg, true), true);
    assert.equal(sends, 1);
    assert.equal(f.calls.length, 1);
}
finally {
    base.store.close();
    await f.close();
} });
test('语音接口成功失败都计入调用统计，不记录调用前拒绝', async () => { let ok = true; const f = await setup((_u, _b, _h, res) => res.end(ok ? '{"text":"成功"}' : '{}')); try {
    const calls: any[] = [];
    (f.speech as any).providers.recordSpeechCall = (...args: any[]) => calls.push(args);
    await f.speech.transcribe(wav);
    ok = false;
    await assert.rejects(f.speech.transcribe(wav));
    f.cfg.llm.roles.asr.model = '';
    await assert.rejects(f.speech.transcribe(wav));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.slice(0, 4)), [['audio', 'asr-model', 'asr', true], ['audio', 'asr-model', 'asr', false]]);
}
finally {
    await f.close();
} });
test('语音识别期间切换话题中止旧回复，不污染新话题', async () => { const f = makeFixture({ name: 'audio-switch', expectedProvider: 'default' }); try {
    f.cfg.speech.asr.enabled = true;
    let enter!: () => void;
    const entered = new Promise<void>(r => enter = r);
    f.pipeline.attachSpeech({ transcribeInbound: async (_msg: unknown, _api: unknown, signal: AbortSignal) => { enter(); await new Promise<void>((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }, replyVoice: async () => false } as unknown as SpeechService);
    const pending = f.pipeline.handle({ ...f.msg, text: '[语音]', segments: [{ type: 'record', data: { file: 'opaque' } }] }, f.api);
    await entered;
    f.store.newConversation(f.msg.scope);
    const result = await pending;
    assert.equal(result.replied, false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.getConversationMessages(f.store.currentConversationId(f.msg.scope)).length, 0);
}
finally {
    f.store.close();
} });
test('语音模型用途在后台列出且空模型不继承聊天模型', () => { const cfg = AppConfigSchema.parse({ llm: { defaultProvider: 'audio', defaultModel: 'chat-model' } }), manager = new RealProviderManager({}, log, 32768, cfg.llm); assert.equal(manager.listRoles().length, 8); assert.equal(manager.resolveRole('chat').model, 'chat-model'); assert.equal(manager.resolveRole('asr').model, ''); assert.equal(manager.resolveRole('tts').model, ''); });
test('面板手填语音模型支持未被发现的服务端模型', async () => { const html = fs.readFileSync('src/web/panel.html', 'utf8'); new vm.Script([...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n')); let sent: any; const ctx: any = { window: {}, $: (id: string) => { assert.equal(id, 'rmanual_asr'); return { value: ' SenseVoiceSmall ' }; }, toast: () => { }, applyRole: async (role: string, patch: unknown) => { sent = { role, patch }; } }; vm.createContext(ctx); vm.runInContext(/window.setManualRoleModel = async[\s\S]*?\n\};/.exec(html)![0], ctx); await ctx.window.setManualRoleModel('asr'); assert.equal(sent.role, 'asr'); assert.equal(sent.patch.model, 'SenseVoiceSmall'); });
