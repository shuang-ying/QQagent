/**
 * 阶段 3/4/5 综合验证：人格 · 记忆 · 情绪 · 压缩
 *
 * 用 Mock OneBot 服务端 + 真实中转站，走完整对话链路。
 * 运行：npm run test:stage345
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, resolveApiKey, migrateLegacyAppConfig, type LoadedConfig } from '../src/config/loader.js';
import { getLogger } from '../src/core/logger.js';
import { MemoryStore, estimateTokens } from '../src/memory/store.js';
import { ProviderManager } from '../src/llm/manager.js';
import { PersonaManager } from '../src/persona/manager.js';
import { TriggerPolicy, isQuietHour, stripMention } from '../src/persona/trigger.js';
import { ProactiveSpeaker } from '../src/persona/proactive.js';
import { EmotionAnalyzer, analyzeByRule, parseEmotionJson, classify } from '../src/emotion/analyzer.js';
import { ContextBuilder } from '../src/context/compressor.js';
import { MemoryRetriever, extractQueryTerms } from '../src/memory/retriever.js';
import { FactExtractor, parseFactsJson } from '../src/memory/extractor.js';
import { ReplyPipeline, cleanReply, splitMessage } from '../src/pipeline/reply.js';
import { ReplyDispatcher } from '../src/pipeline/dispatch.js';
import { CommandHandler } from '../src/pipeline/commands.js';
import { NapCatClient } from '../src/napcat/client.js';
import type { AppConfig } from '../src/core/types.js';
import { contentToText } from '../src/core/types.js';

const PORT = 3011;
const BOT_QQ = 10001;
const USER_QQ = 20002;
const OTHER_QQ = 20003;
const GROUP_ID = 30003;

let pass = 0;
let fail = 0;
let skip = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function skipping(name: string, why: string): void {
  skip++;
  console.log(`  ⏭  ${name} — ${why}`);
}
function section(t: string): void {
  console.log(`\n【${t}】`);
}

// ============================================================
// 阶段 3：人格系统
// ============================================================
function testPersona(store: MemoryStore, cfg: AppConfig, personas: LoadedConfig['personas']): void {
  section('阶段3 · 人格系统');

  const log = getLogger('t');
  const pm = new PersonaManager(personas, cfg, store, log);

  check('加载了全部预设人格（>=6）', pm.list().length >= 6, `${pm.list().length}`);
  check('含猫娘人格', pm.has('catgirl'));
  check('猫娘有情绪调制配置', Object.keys(pm.get('catgirl')!.emotionModulation).length >= 4);
  check('含傲娇人格', pm.has('tsundere'));
  check('含温柔姐姐', pm.has('gentle'));
  check('含元气少女', pm.has('genki'));
  check('含冷酷助手', pm.has('cool'));
  check('含蓝色大肥鱼人格', pm.has('blue-fish'));
  check('含博学学者', pm.has('sage'));

  // 每人格都有 systemPrompt
  check('所有人格都有 systemPrompt', pm.list().every((p) => p.systemPrompt.trim().length > 50));

  // 默认人格解析
  const r1 = pm.resolve('group:999999', USER_QQ);
  check('未设置的会话回退到默认人格', r1.persona.id === cfg.persona.default, `${r1.persona.id}/${r1.source}`);

  // 会话级覆盖
  store.touchSession('group:990001', 'group', 990001, '测试群');
  pm.setForSession('group:990001', 'cool');
  const r2 = pm.resolve('group:990001', USER_QQ);
  check('会话级人格覆盖生效', r2.persona.id === 'cool', r2.persona.id);
  check('人格来源标记为 session', r2.source === 'session', r2.source);

  // 不同会话互不影响
  store.touchSession('group:990002', 'group', 990002, '另一个群');
  const r3 = pm.resolve('group:990002', USER_QQ);
  check('其他会话不受影响（按会话隔离）', r3.persona.id === cfg.persona.default, r3.persona.id);

  // 会话尚未创建时也能设置人格（UPSERT 路径）
  pm.setForSession('group:990003', 'sage');
  const autoSession = store.getSession('group:990003');
  check('会话不存在时切换人格也能落库', autoSession?.persona_id === 'sage', String(autoSession?.persona_id));

  // 用户级覆盖（私聊）—— 用一个独立的 QQ，避免污染后续端到端测试
  const privUser = 555099;
  store.touchUser(privUser, '私聊测试用户');
  pm.setForUser(privUser, 'genki');
  const r4 = pm.resolve(`private:${privUser}`, privUser);
  check('私聊用户级人格覆盖生效', r4.persona.id === 'genki', `${r4.persona.id}/${r4.source}`);
  // 端到端用的 USER_QQ 不应被用户级设置污染
  const r4b = pm.resolve(`private:${USER_QQ}`, USER_QQ);
  check('未设置的用户走默认人格', r4b.persona.id === cfg.persona.default, `${r4b.persona.id}/${r4b.source}`);

  // 无效人格
  check('拒绝设置不存在的人格', pm.setForSession('group:999999', 'not-exist') === false);

  // system prompt 组装
  const catgirl = pm.get('catgirl')!;
  const sp = pm.buildSystemPrompt({
    persona: catgirl,
    context: { scopeType: 'group', senderName: '小明', senderId: USER_QQ, groupName: '测试群' },
    emotion: { label: 'sadness', intensity: 0.8, valence: -0.7, arousal: 0.3 },
    facts: ['用户喜欢喝无糖可乐'],
    summaries: ['上次聊到了考研的事'],
  });

  check('system prompt 含人格设定', sp.includes('猫娘'));
  check('system prompt 含情景(群聊)', sp.includes('群聊'));
  check('system prompt 含说话人身份', sp.includes('小明') && sp.includes(String(USER_QQ)));
  check('system prompt 含情绪调制', sp.includes('语气调整') && sp.includes('悲伤') === false);
  check('system prompt 注入记忆事实', sp.includes('无糖可乐'));
  check('system prompt 注入摘要', sp.includes('考研'));
  check('system prompt 含输出约束', sp.includes('输出要求'));

  // 情绪调制差异
  const spJoy = pm.buildSystemPrompt({ persona: catgirl, emotion: { label: 'joy', intensity: 0.9, valence: 0.8, arousal: 0.8 } });
  const spSad = pm.buildSystemPrompt({ persona: catgirl, emotion: { label: 'sadness', intensity: 0.9, valence: -0.8, arousal: 0.3 } });
  check('不同情绪产生不同 prompt', spJoy !== spSad);
  check('喜悦调制使用 joy 文案', spJoy.includes(catgirl.emotionModulation['joy']!.slice(0, 8)));
  check('悲伤调制使用 sadness 文案', spSad.includes(catgirl.emotionModulation['sadness']!.slice(0, 8)));

  // 冷酷人格几乎不受情绪影响
  const cool = pm.get('cool')!;
  const coolJoy = pm.buildSystemPrompt({ persona: cool, emotion: { label: 'joy', intensity: 1, valence: 1, arousal: 1 } });
  check('冷酷人格也有情绪调制文案(最小调整)', coolJoy.includes(cool.emotionModulation['joy']!.slice(0, 6)));
}

// ============================================================
// 阶段 3：触发策略
// ============================================================
function testTrigger(cfg: AppConfig): void {
  section('阶段3 · 触发策略');

  const log = getLogger('t');
  // 清掉用户真实的准入配置，否则用户配了自己的群号/白名单后，
  // 这里构造的测试群会被拦掉，导致全部群聊用例误报失败
  const cleanTrigger = (over?: Partial<AppConfig['trigger']>): AppConfig['trigger'] => {
    const base: AppConfig['trigger'] = {
      ...cfg.trigger,
      allowUsers: [],
      denyUsers: [],
      admins: [],
      commandAdminOnly: false,
      personaAdminOnly: false,
      group: { ...cfg.trigger.group, enabledGroups: [] },
    };
    if (!over) return base;
    const merged: AppConfig['trigger'] = { ...base, ...over };
    if (over.group) {
      merged.group = { ...base.group, ...over.group, enabledGroups: over.group.enabledGroups ?? [] };
    }
    return merged;
  };
  /** 干净的群配置基础：不含用户真实的群白名单 */
  const groupBase: AppConfig['trigger']['group'] = { ...cfg.trigger.group, enabledGroups: [] };
  const mk = (over?: Partial<AppConfig['trigger']>): TriggerPolicy =>
    new TriggerPolicy(cleanTrigger(over), log);

  const policy = mk();
  const baseMsg = {
    scope: `group:${GROUP_ID}`,
    scopeType: 'group' as const,
    userId: USER_QQ,
    groupId: GROUP_ID,
    messageId: 1,
    selfId: BOT_QQ,
    text: '你好',
    segments: [{ type: 'text', data: { text: '你好' } }],
    mentionsBot: false,
    senderName: '测试',
    timestamp: Date.now(),
    raw: {} as never,
  };

  check('群聊未@机器人 → 不回复', policy.decide(baseMsg, BOT_QQ).reply === false);
  check('群聊@机器人 → 回复', policy.decide({ ...baseMsg, mentionsBot: true, text: '@你 你好' }, BOT_QQ).reply === true);

  const atDecision = policy.decide({ ...baseMsg, mentionsBot: true, text: '@你 你好' }, BOT_QQ);
  check(
    '@机器人后剥离@痕迹',
    atDecision.reply === true && !atDecision.text.includes('@你'),
    atDecision.reply ? atDecision.text : '',
  );

  // 私聊默认 always
  check(
    '私聊默认回复',
    policy.decide({ ...baseMsg, scope: `private:${USER_QQ}`, scopeType: 'private', mentionsBot: false }, BOT_QQ).reply === true,
  );

  // 自己发的消息
  check('忽略机器人自己的消息', policy.decide({ ...baseMsg, userId: BOT_QQ, mentionsBot: true }, BOT_QQ).reply === false);

  // 黑名单
  const deny = mk({ denyUsers: [USER_QQ] });
  check('黑名单用户不回复', deny.decide({ ...baseMsg, mentionsBot: true }, BOT_QQ).reply === false);

  // 白名单
  const allow = mk({ allowUsers: [OTHER_QQ] });
  check('白名单外用户不回复', allow.decide({ ...baseMsg, mentionsBot: true }, BOT_QQ).reply === false);
  check('白名单内用户回复', allow.decide({ ...baseMsg, userId: OTHER_QQ, mentionsBot: true }, BOT_QQ).reply === true);

  // 关键词触发
  const kw = mk({ group: { ...groupBase, keywords: ['猫咪', '喵'] } });
  check('群聊命中关键词 → 回复', kw.decide({ ...baseMsg, text: '这只猫咪好可爱' }, BOT_QQ).reply === true);
  check('群聊未命中关键词 → 不回复', kw.decide({ ...baseMsg, text: '今天天气不错' }, BOT_QQ).reply === false);

  // 前缀触发
  const pf = mk({ group: { ...groupBase, prefixes: ['/ai'] } });
  const pfDecision = pf.decide({ ...baseMsg, text: '/ai 你好' }, BOT_QQ);
  check('前缀触发 → 回复', pfDecision.reply === true);
  check('前缀被剥离', pfDecision.reply === true && pfDecision.text === '你好', pfDecision.reply ? pfDecision.text : '');

  // 冷却
  const cool = mk({ group: { ...groupBase, cooldownMs: 60000 } });
  cool.beginGenerating(`group:${GROUP_ID}`);
  cool.endGenerating(`group:${GROUP_ID}`, true);
  const d = cool.decide({ ...baseMsg, mentionsBot: true }, BOT_QQ);
  check('冷却期内不回复', d.reply === false, d.reply === false ? d.reason : '');

  // 并发上限
  const conc = mk({ group: { ...groupBase, maxConcurrent: 1, cooldownMs: 0 } });
  conc.beginGenerating(`group:${GROUP_ID}`);
  check('并发达上限不回复', conc.decide({ ...baseMsg, mentionsBot: true }, BOT_QQ).reply === false);

  // 群白名单
  const gw = mk({ group: { ...groupBase, enabledGroups: [999] } });
  check('群不在白名单不回复', gw.decide({ ...baseMsg, mentionsBot: true }, BOT_QQ).reply === false);

  // 空消息
  check('空消息不回复', policy.decide({ ...baseMsg, text: '', segments: [], mentionsBot: true }, BOT_QQ).reply === false);

  // 免打扰时段
  check('免打扰: 23:30 属于 23:00-08:00', isQuietHour(['23:00-08:00'], new Date('2026-01-01T23:30:00')) === true);
  check('免打扰: 03:00 属于 23:00-08:00', isQuietHour(['23:00-08:00'], new Date('2026-01-01T03:00:00')) === true);
  check('免打扰: 12:00 不属于', isQuietHour(['23:00-08:00'], new Date('2026-01-01T12:00:00')) === false);
  check('免打扰: 非跨午夜区间 09:00-17:00 内', isQuietHour(['09:00-17:00'], new Date('2026-01-01T10:00:00')) === true);
  check('免打扰: 非跨午夜区间外', isQuietHour(['09:00-17:00'], new Date('2026-01-01T20:00:00')) === false);

  check('stripMention 去@', stripMention('@你 你好') === '你好', stripMention('@你 你好'));
}

// ============================================================
// 阶段 5：情绪分析（规则）
// ============================================================
function testEmotionRule(): void {
  section('阶段5 · 情绪分析（规则引擎）');

  const joy = analyzeByRule('今天太开心了哈哈哈哈！！！');
  check('喜悦: 效价为正', joy.valence > 0.3, String(joy.valence));
  check('喜悦: 标签为 joy 或 calm-happy', ['joy', 'calm-happy'].includes(joy.label), joy.label);
  check('喜悦: 高唤醒', joy.arousal > 0.5, String(joy.arousal));

  const sad = analyzeByRule('好难过啊，想哭……');
  check('悲伤: 效价为负', sad.valence < -0.3, String(sad.valence));
  check('悲伤: 标签为 sadness', sad.label === 'sadness', sad.label);

  const angry = analyzeByRule('烦死了！气死我了！');
  check('愤怒: 效价为负', angry.valence < -0.3, String(angry.valence));
  check('愤怒: 高唤醒', angry.arousal > 0.5, String(angry.arousal));
  check('愤怒: 标签为 anger', angry.label === 'anger', angry.label);

  const anxious = analyzeByRule('压力好大，好紧张，怎么办啊？？');
  check('焦虑: 效价为负', anxious.valence < -0.1, String(anxious.valence));
  check('焦虑: 标签为 anxiety', anxious.label === 'anxiety', `label=${anxious.label} d=${anxious.dominance}`);

  const neutral = analyzeByRule('嗯');
  check('中性: 效价接近0', Math.abs(neutral.valence) < 0.3, String(neutral.valence));
  check('中性: 低强度', neutral.intensity < 0.5, String(neutral.intensity));

  // 否定翻转
  const neg = analyzeByRule('我不开心');
  check('否定词翻转效价', neg.valence < 0, `不开心 valence=${neg.valence}`);

  // 程度副词
  const strong = analyzeByRule('非常开心');
  const mild = analyzeByRule('有点开心');
  check('程度副词放大强度', strong.intensity > mild.intensity, `${strong.intensity} vs ${mild.intensity}`);

  // 英文/网络用语
  const laugh = analyzeByRule('笑死我了 hhh');
  check('识别网络笑声', laugh.matched.includes('笑声'), laugh.matched.join(','));

  // 分类函数
  check('classify: 正效价高唤醒→joy', classify(0.8, 0.8, 0.6, 0.8) === 'joy');
  check('classify: 负效价高唤醒高支配→anger', classify(-0.8, 0.8, 0.8, 0.8) === 'anger');
  check('classify: 负效价高唤醒低支配→anxiety', classify(-0.8, 0.8, 0.2, 0.8) === 'anxiety');
  check('classify: 负效价低唤醒→sadness', classify(-0.8, 0.3, 0.3, 0.8) === 'sadness');
  check('classify: 低强度→neutral', classify(0.1, 0.1, 0.5, 0.1) === 'neutral');

  // JSON 解析健壮性
  const parsed = parseEmotionJson('```json\n{"label":"joy","valence":0.9,"arousal":0.8,"dominance":0.7,"intensity":0.9,"confidence":0.95}\n```');
  check('解析带代码块的 JSON', parsed?.label === 'joy' && parsed.valence === 0.9, JSON.stringify(parsed));

  const parsed2 = parseEmotionJson('前面废话 {"label":"anger","valence":-0.9} 后面废话');
  check('解析夹杂文字的 JSON', parsed2?.label === 'anger', JSON.stringify(parsed2));

  const parsed3 = parseEmotionJson('完全不是JSON');
  check('无法解析时返回 null', parsed3 === null);

  const parsed4 = parseEmotionJson('{"label":"invalid_label","valence":5}');
  check('非法标签回退 neutral', parsed4?.label === 'neutral', parsed4?.label);
  check('越界数值被裁剪', parsed4?.valence === 1, String(parsed4?.valence));
}

// ============================================================
// 阶段 4：记忆系统
// ============================================================
function testMemory(store: MemoryStore): void {
  section('阶段4 · 记忆系统（QQ 为唯一 ID）');

  const uid = 555001;
  const other = 555002;
  const scopeA = 'group:700001';
  const scopeB = 'group:700002';

  // 用户以 QQ 为唯一 ID
  store.touchUser(uid, '小明');
  const u = store.getUser(uid);
  check('用户以 QQ 为主键存储', u?.user_id === uid);
  check('记录昵称', u?.nickname === '小明');

  // 昵称变更记录别名
  store.touchUser(uid, '小明改名了');
  const u2 = store.getUser(uid);
  check('昵称更新', u2?.nickname === '小明改名了');
  check('旧昵称进入别名历史', JSON.parse(u2!.aliases).includes('小明'), u2!.aliases);

  // 两个用户独立
  store.touchUser(other, '小红');
  check('不同 QQ 是不同用户', store.getUser(other)?.nickname === '小红');

  // 会话隔离
  store.touchSession(scopeA, 'group', 700001, 'A群');
  store.touchSession(scopeB, 'group', 700002, 'B群');
  check('会话按 scope 隔离', store.getSession(scopeA)?.title === 'A群' && store.getSession(scopeB)?.title === 'B群');

  // 消息落库
  store.addMessage({ scope: scopeA, userId: uid, role: 'user', content: '我最近在学 Rust' });
  store.addMessage({ scope: scopeA, userId: 0, role: 'assistant', content: 'Rust 很酷！' });
  store.addMessage({ scope: scopeB, userId: uid, role: 'user', content: '今天天气不错' });
  check('消息落库', store.getRecentMessages(scopeA, 10).length === 2);
  check('会话消息隔离(A群2条)', store.getRecentMessages(scopeA, 10).length === 2);
  check('会话消息隔离(B群1条)', store.getRecentMessages(scopeB, 10).length === 1);

  // 长期事实 + 跨会话共享策略
  const f1 = store.addFact({ userId: uid, scope: scopeA, factType: 'identity', content: '用户是后端工程师', keywords: '后端 工程师 职业', shareable: true });
  const f2 = store.addFact({ userId: uid, scope: scopeA, factType: 'preference', content: '用户喜欢喝无糖可乐', keywords: '无糖 可乐 喜欢', shareable: true });
  const f3 = store.addFact({ userId: uid, scope: scopeA, factType: 'event', content: '用户在A群说了个秘密', keywords: '秘密', shareable: false });

  check('事实落库', store.getFactsByUser(uid).length === 3);

  // 可共享事实在别的会话可见
  const inB = store.getFactsByUser(uid, { scope: scopeB, shareableOnly: true });
  check('跨会话: 可共享事实(B群可见)', inB.some((f) => f.content.includes('后端工程师')), `${inB.length} 条`);
  check('跨会话: 不可共享事实被隔离', !inB.some((f) => f.content.includes('秘密')), inB.map((f) => f.content).join(';'));

  // 本会话内所有事实可见
  const inA = store.getFactsByUser(uid, { scope: scopeA });
  check('本会话: 全部事实可见', inA.length === 3, `${inA.length}`);

  // FTS 检索
  const found = store.searchFacts(uid, '可乐', { scope: scopeA });
  check('FTS 检索命中', found.some((f) => f.content.includes('可乐')), found.map((f) => f.content).join(';'));

  const foundEn = store.searchFacts(uid, '工程师', { scope: scopeA });
  check('FTS 中文检索命中', foundEn.length > 0, `${foundEn.length}`);

  const foundNone = store.searchFacts(uid, '量子力学', { scope: scopeA });
  check('无关查询不误召回', foundNone.length === 0, `${foundNone.length}`);

  // 检索权重含时间衰减
  const scored = store.searchFacts(uid, '可乐', { scope: scopeA });
  check('检索结果带分数', scored.length > 0 && typeof scored[0]!.score === 'number');

  // 去重
  check('findSimilarFact 可检测重复', store.findSimilarFact(uid, '用户喜欢喝无糖可乐') !== undefined);
  check('findSimilarFact 不误判', store.findSimilarFact(uid, '完全不同的内容xyz') === undefined);

  // 召回计数
  store.markFactsHit([f1]);
  check('召回计数更新', (store.getFactsByUser(uid).find((f) => f.id === f1)?.hit_count ?? 0) >= 1);

  // 删除
  store.deleteFact(f3);
  check('事实可删除', store.getFactsByUser(uid).length === 2);

  // 摘要
  const msgs = [];
  for (let i = 0; i < 50; i++) {
    msgs.push(store.addMessage({ scope: scopeA, userId: uid, role: 'user', content: `第${i}条消息` }));
  }
  check('未摘要计数正确', store.countUnsummarized(scopeA) >= 50, `${store.countUnsummarized(scopeA)}`);

  store.addSummary(scopeA, 1, '这是一段摘要', msgs[0]!, msgs[10]!, 11);
  store.markSummarized(msgs.slice(0, 11));
  check('摘要落库', store.getSummaries(scopeA, 1).length === 1);
  // 之前此会话已有 3 条消息（2 用户 + 1 AI），加 50 条 = 53；标记 11 条后应为 42
  const remaining = store.countUnsummarized(scopeA);
  check('标记已摘要后计数下降', remaining === 41, `${remaining}`);
  check('原文仍保留在库中(不删除)', store.getRecentMessages(scopeA, 200).length >= 52, `${store.getRecentMessages(scopeA, 200).length}`);

  // 情绪状态
  const emo = store.updateEmotionState(uid, scopeA, { label: 'joy', confidence: 0.9, valence: 0.8, arousal: 0.7, dominance: 0.6, intensity: 0.8 }, 0.5);
  check('情绪状态落库', emo.label === 'joy');
  const emo2 = store.updateEmotionState(uid, scopeA, { label: 'sadness', confidence: 0.9, valence: -0.8, arousal: 0.3, dominance: 0.3, intensity: 0.7 }, 0.3);
  check('情绪 EMA 平滑(不会突变)', emo2.valence > -0.8 && emo2.valence < 0.8, String(emo2.valence));
  check('情绪样本累计', emo2.samples === 2, String(emo2.samples));
  check('情绪历史有记录', store.getEmotionHistory(uid).length === 2);

  // 情绪按会话隔离
  const emoB = store.getEmotionState(uid, scopeB);
  check('情绪状态按会话隔离', emoB === undefined);

  // 群成员
  store.touchGroupMember(700001, uid, '小明卡片', '小明', 'member');
  store.touchGroupMember(700001, uid, '小明卡片', '小明', 'member');
  const gm = store.getGroupMember(700001, uid);
  check('群成员计数累计', gm?.message_count === 2, String(gm?.message_count));
  check('群成员列表', store.listGroupMembers(700001).length === 1);
}

// ============================================================
// 阶段 5：查询词提取与消息处理工具
// ============================================================
function testUtils(): void {
  section('阶段5 · 工具函数');

  const terms = extractQueryTerms('我最近在学 Rust 和 Python');
  check('提取英文词', terms.includes('Rust') || terms.toLowerCase().includes('rust'), terms);
  check('提取中文词', terms.length > 0, terms);

  const t2 = extractQueryTerms('你好');
  check('停用词被过滤后仍有结果或为空', typeof t2 === 'string');

  // cleanReply
  check('清理角色前缀', cleanReply('assistant: 你好') === '你好', cleanReply('assistant: 你好'));
  check('清理引号包裹', cleanReply('"你好呀"') === '你好呀', cleanReply('"你好呀"'));
  check('清理 markdown 加粗', cleanReply('**重点**内容') === '重点内容', cleanReply('**重点**内容'));
  check('清理代码块', cleanReply('```\n你好\n```') === '你好', cleanReply('```\n你好\n```'));
  check('清理标题符号', !cleanReply('# 标题\n内容').includes('#'), cleanReply('# 标题\n内容'));

  // splitMessage
  const short = splitMessage('短消息', 500);
  check('短消息不分片', short.length === 1);

  const long = splitMessage('测试句子。'.repeat(200), 100);
  check('长消息分片', long.length > 1, `${long.length} 片`);
  check('分片后各片不超过限制(允许少量余量)', long.every((p) => p.length <= 120), long.map((p) => p.length).join(','));
  check('分片内容无丢失', long.join('').replace(/\s/g, '').length === '测试句子。'.repeat(200).replace(/\s/g, '').length);

  const withNewline = splitMessage('第一段\n\n第二段\n\n第三段'.repeat(30), 50);
  check('优先在换行处分片', withNewline.length > 1);

  // token 估算
  check('token 估算: 中文', estimateTokens('你好世界') > 0 && estimateTokens('你好世界') < 10);
  check('token 估算: 空字符串为0', estimateTokens('') === 0);
  check('token 估算: 长文本更大', estimateTokens('a'.repeat(100)) > estimateTokens('a'.repeat(10)));

  // 事实 JSON 解析
  const facts = parseFactsJson('[{"type":"preference","content":"用户喜欢猫","keywords":"猫 喜欢","confidence":0.9}]');
  check('解析事实数组', facts.length === 1 && facts[0]!.factType === 'preference', JSON.stringify(facts));
  check('解析非法类型回退 other', parseFactsJson('[{"type":"bogus","content":"x"}]')[0]?.factType === 'other');
  check('空数组', parseFactsJson('[]').length === 0);
  check('非 JSON 返回空', parseFactsJson('没有事实').length === 0);
  check('单对象容错', parseFactsJson('{"type":"identity","content":"用户是学生"}').length === 1);
}

// ============================================================
// 阶段 5：上下文压缩
// ============================================================
function testContext(cfg: AppConfig, store: MemoryStore): void {
  section('阶段5 · 上下文压缩');

  const log = getLogger('t');
  const cb = new ContextBuilder(cfg.context, cfg.memory, store, log);
  const scope = 'group:800001';
  const uid = 555010;
  store.touchSession(scope, 'group', 800001, '压测群');
  store.touchUser(uid, '压测用户');

  // 预算计算
  const budget = cb.budget(32768);
  check('预算 = 窗口*比例 - 预留', budget === Math.floor(32768 * 0.7) - 1024, String(budget));
  check('预算为正', budget > 0);

  // 空历史
  const empty = cb.build({ scope, userId: uid, systemPrompt: '你是助手', userMessage: '你好', contextWindow: 32768 });
  check('空历史: 含 system', empty.messages[0]?.role === 'system');
  check('空历史: 含用户消息', empty.messages[empty.messages.length - 1]?.content === '你好');
  check('空历史: 无裁剪', empty.stats.trimmedMessages === 0);

  // 大量历史触发裁剪（用很小的窗口确保一定裁剪）
  for (let i = 0; i < 300; i++) {
    store.addMessage({ scope, userId: uid, role: i % 2 === 0 ? 'user' : 'assistant', content: `这是第${i}条测试消息，内容需要有一定长度才能占用token。`.repeat(2) });
  }
  const big = cb.build({ scope, userId: uid, systemPrompt: '你是助手', userMessage: '最新问题', contextWindow: 2048 });
  check('长历史: 发生裁剪', big.stats.trimmedMessages > 0, `裁剪 ${big.stats.trimmedMessages}`);
  check('长历史: 总 token 不超预算', big.stats.totalTokens <= big.stats.budget + 200, `${big.stats.totalTokens} vs ${big.stats.budget}`);
  check('长历史: 保留最近消息', big.messages.length > 1);
  check('长历史: 最后一条是当前问题', big.messages[big.messages.length - 1]?.content === '最新问题');

  // 群聊环境上下文
  const withAmbient = cb.build({
    scope,
    userId: uid,
    systemPrompt: '你是助手',
    userMessage: '你好',
    contextWindow: 32768,
    ambientContext: '【群里最近其他人说的话】\n张三: 大家好',
  });
  check('注入群聊环境上下文', withAmbient.messages.some((m) => contentToText(m.content).includes('张三')));
  check('环境上下文计入 token', withAmbient.stats.ambientTokens > 0);

  // 小窗口模型（注意：预算有 512 的下限，所以要和足够大的窗口对比才有差异）
  const tiny = cb.build({ scope, userId: uid, systemPrompt: '你是助手', userMessage: '你好', contextWindow: 2048 });
  const huge = cb.build({ scope, userId: uid, systemPrompt: '你是助手', userMessage: '你好', contextWindow: 200000 });
  check('小窗口模型: 预算有下限保护(≥512)', tiny.stats.budget >= 512, `${tiny.stats.budget}`);
  check('小窗口模型: 预算小于大窗口', tiny.stats.budget < huge.stats.budget, `${tiny.stats.budget} vs ${huge.stats.budget}`);
  check('小窗口模型: 仍不超预算', tiny.stats.totalTokens <= tiny.stats.budget + 200, `${tiny.stats.totalTokens} vs ${tiny.stats.budget}`);
  check('大窗口模型: 预算更大', huge.stats.budget > tiny.stats.budget, `${huge.stats.budget}`);

  // 压缩触发判断
  const scope2 = 'group:800002';
  store.touchSession(scope2, 'group', 800002, '压缩群');
  check('消息少时不触发压缩', cb.shouldCompress(scope2) === false);
  for (let i = 0; i < cfg.memory.summary.triggerMessages + 5; i++) {
    store.addMessage({ scope: scope2, userId: uid, role: 'user', content: `消息${i}` });
  }
  check('消息超过阈值触发压缩', cb.shouldCompress(scope2) === true);
}

// ============================================================
// 阶段 3-5：真实端到端对话（Mock NapCat + 真实 LLM）
// ============================================================
interface SentMsg {
  scope: string;
  content: string;
  at: number;
}

async function testEndToEnd(
  cfg: AppConfig,
  providers: LoadedConfig['providers'],
  personas: LoadedConfig['personas'],
  store: MemoryStore,
): Promise<void> {
  section('阶段3-5 · 真实端到端（Mock NapCat + 真实模型）');

  // 用当前配置里的默认供应商（不假设特定中转站）。
  // 可用 E2E_PROVIDER=xxx 指定另一个供应商跑端到端，便于默认供应商临时故障时仍能验证管线。
  const providerKey = process.env.E2E_PROVIDER || cfg.llm.defaultProvider || Object.keys(providers)[0] || '';
  const relay = providers[providerKey];
  const apiKey = relay ? resolveApiKey(relay) : '';
  if (!relay || (!apiKey && relay.protocol !== 'ollama')) {
    skipping('端到端测试', `供应商 ${providerKey || '(无)'} 未配置可用密钥`);
    return;
  }
  // 让管线内部也使用这个供应商
  cfg.llm.defaultProvider = providerKey;
  cfg.llm.defaultModel = process.env.E2E_MODEL || '';
  console.log(
    `  ℹ 端到端供应商: ${providerKey} (${relay.baseURL})${cfg.llm.defaultModel ? ' model=' + cfg.llm.defaultModel : ''}`,
  );

  const log = getLogger('e2e');
  const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));

  const sent: SentMsg[] = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const req = JSON.parse(raw.toString()) as { action: string; params: Record<string, unknown>; echo: unknown };
      let data: unknown = {};
      let status: 'ok' | 'failed' = 'ok';
      switch (req.action) {
        case 'get_login_info':
          data = { user_id: BOT_QQ, nickname: 'E2EBot' };
          break;
        case 'get_status':
          data = { online: true, good: true };
          break;
        case 'send_group_msg':
          sent.push({ scope: `group:${req.params['group_id']}`, content: String(req.params['message']), at: Date.now() });
          data = { message_id: 1 };
          break;
        case 'send_private_msg':
          sent.push({ scope: `private:${req.params['user_id']}`, content: String(req.params['message']), at: Date.now() });
          data = { message_id: 1 };
          break;
        default:
          data = {};
      }
      ws.send(JSON.stringify({ status, retcode: 0, data, echo: req.echo }));
    });
  });

  const napcat = new NapCatClient(
    { ...cfg.napcat, url: `ws://127.0.0.1:${PORT}`, reconnect: { initialMs: 200, maxMs: 1000, factor: 1.5 } },
    log,
  );

  // 传入 cfg.llm，让「模型用途」（vision/emotion/…）解析与生产一致
  const providersMgr = new ProviderManager(providers, log, cfg.context.modelContextWindow, cfg.llm);
  const personaMgr = new PersonaManager(personas, cfg, store, log);
  // 触发策略要清掉用户真实的准入配置（群白名单/用户白名单/黑名单），
  // 否则用户一旦配了自己的群号，这里构造的测试群就会被拦掉而误报失败。
  const trigger = new TriggerPolicy(
    {
      ...cfg.trigger,
      allowUsers: [],
      denyUsers: [],
      group: { ...cfg.trigger.group, cooldownMs: 0, enabledGroups: [] },
    },
    log,
  );
  const emotion = new EmotionAnalyzer('rule', providersMgr, cfg.llm.defaultProvider, '', log);
  const cb = new ContextBuilder(cfg.context, cfg.memory, store, log);
  const retriever = new MemoryRetriever(store, cfg.memory, log);
  const extractor = new FactExtractor(providersMgr, cfg.llm.defaultProvider, '', store, log, cfg.memory.retrieval.shareableFactTypes);
  // 端到端测试关闭分条与人为延迟：否则每个用例都要等好几秒，且断言"发了几条"会变复杂
  const dispatcher = new ReplyDispatcher(
    {
      ...cfg.reply,
      segmented: { ...cfg.reply.segmented, enabled: false },
      typingDelayMs: [0, 0],
      mentionOnReply: false,
      quoteOnReply: false,
    },
    log,
  );
  const pipeline = new ReplyPipeline(cfg, store, providersMgr, personaMgr, trigger, emotion, cb, retriever, extractor, dispatcher, null, log);
  const commands = new CommandHandler(cfg, store, personaMgr, log);

  let ready = false;
  napcat.on('ready', () => {
    ready = true;
  });
  napcat.start();

  await waitFor(() => ready, 8000, '等待连接');

  const scope = `private:${USER_QQ}`;
  // 用专门的人格确保可预测
  personaMgr.setForSession(scope, 'catgirl');

  // ---- 第 1 轮：私聊 ----
  const r1 = await pipeline.handle(
    mkMsg({ scope, scopeType: 'private', text: '你好呀，我叫小明，是个后端工程师', userId: USER_QQ, selfId: BOT_QQ }),
    napcat.api,
  );
  check('端到端: 第1轮成功回复', r1.replied === true, r1.reason ?? '');
  check('端到端: 回复非空', (r1.content?.length ?? 0) > 0, r1.content?.slice(0, 80));
  check('端到端: 使用了猫娘人格', r1.personaId === 'catgirl', r1.personaId);
  check('端到端: 消息已发送到 NapCat', sent.some((s) => s.scope === scope), `${sent.length} 条`);
  check('端到端: 记录了情绪', !!r1.emotion, JSON.stringify(r1.emotion));
  console.log(`  ℹ 用户: 你好呀，我叫小明，是个后端工程师`);
  console.log(`  ℹ 猫娘: ${r1.content?.slice(0, 100)}`);

  // ---- 第 2 轮：情绪化输入 ----
  const r2 = await pipeline.handle(
    mkMsg({ scope, scopeType: 'private', text: '今天工作好累啊，压力特别大，感觉快崩溃了', userId: USER_QQ, selfId: BOT_QQ }),
    napcat.api,
  );
  check('端到端: 第2轮成功回复', r2.replied === true, r2.reason ?? '');
  check('端到端: 检测到负面情绪', (r2.emotion?.label ?? 'neutral') !== 'joy', JSON.stringify(r2.emotion));
  console.log(`  ℹ 用户: 今天工作好累啊，压力特别大，感觉快崩溃了`);
  console.log(`  ℹ 情绪: ${r2.emotion?.label}(${r2.emotion?.intensity.toFixed(2)})`);
  console.log(`  ℹ 猫娘: ${r2.content?.slice(0, 100)}`);

  // 情绪状态应已更新
  const emoState = store.getEmotionState(USER_QQ, scope);
  check('端到端: 情绪状态已落库', emoState !== undefined && emoState.samples >= 2, `samples=${emoState?.samples}`);

  // ---- 记忆召回验证 ----
  // 手工注入一条记忆，然后问相关问题，验证召回
  store.addFact({
    userId: USER_QQ,
    scope,
    factType: 'preference',
    content: '用户喜欢喝无糖可乐',
    keywords: '无糖 可乐 喜欢 喝',
    confidence: 0.95,
    shareable: true,
  });
  const memCheck = retriever.retrieve(scope, USER_QQ, '我想喝点什么，推荐一下');
  check('记忆检索: 能召回相关事实', memCheck.facts.some((f) => f.includes('可乐')), memCheck.facts.join(';'));

  const r3 = await pipeline.handle(
    mkMsg({ scope, scopeType: 'private', text: '我有点渴了，你说我喝点什么好', userId: USER_QQ, selfId: BOT_QQ }),
    napcat.api,
  );
  check('端到端: 第3轮成功回复', r3.replied === true, r3.reason ?? '');
  check('端到端: 上下文中注入了记忆', (r3.debug?.memoryFacts ?? 0) > 0, `${r3.debug?.memoryFacts}`);
  console.log(`  ℹ 用户: 我有点渴了，你说我喝点什么好`);
  console.log(`  ℹ 猫娘: ${r3.content?.slice(0, 100)}`);

  // ---- 群聊上下文（其他人发言被记录）----
  const gscope = `group:${GROUP_ID}`;
  personaMgr.setForSession(gscope, 'catgirl');
  // 别人说话（未@机器人，不回复但应被记录）
  await pipeline.handle(
    mkMsg({ scope: gscope, scopeType: 'group', text: '有人知道怎么配 NapCat 吗', userId: OTHER_QQ, selfId: BOT_QQ, groupId: GROUP_ID, mentionsBot: false }),
    napcat.api,
  );
  const gmsgs = store.getRecentMessages(gscope, 10);
  check('群聊: 其他人的发言被记录为上下文', gmsgs.some((m) => m.user_id === OTHER_QQ), `${gmsgs.length} 条`);
  check('群聊: 未@机器人时不回复', !sent.some((s) => s.scope === gscope), '不应有群消息');

  // @机器人则回复
  const r4 = await pipeline.handle(
    mkMsg({ scope: gscope, scopeType: 'group', text: '@你 你知道怎么配吗', userId: USER_QQ, selfId: BOT_QQ, groupId: GROUP_ID, mentionsBot: true }),
    napcat.api,
  );
  check('群聊: @机器人时回复', r4.replied === true, r4.reason ?? '');
  check('群聊: 回复已发送', sent.some((s) => s.scope === gscope));
  console.log(`  ℹ 群聊@: ${r4.content?.slice(0, 100)}`);

  // ---- 图片理解端到端（真发图给模型）----
  // 只在「图片理解」用途确实配了视觉模型时才跑，否则跳过。
  {
    const visionRole = providersMgr.resolveRole('vision');
    const visionOk = visionRole.provider && visionRole.model
      ? providersMgr.visionHealth().ok
      : false;

    if (!visionOk) {
      skipping('图片理解', `未配置可用的视觉模型（${visionRole.provider || '-'}/${visionRole.model || '-'}）`);
    } else {
      // 造一张纯色 PNG（手写最小 PNG 编码器，不引依赖）
      const zlib = await import('node:zlib');
      const T = (() => { const t = new Int32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c;} return t; })();
      const crc32 = (b: Buffer) => { let c=0xffffffff; for (const x of b) c=T[(c^x)&0xff]!^(c>>>8); return (c^0xffffffff)>>>0; };
      const chunk = (ty: string, d: Buffer) => {
        const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
        const td = Buffer.concat([Buffer.from(ty, 'ascii'), d]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
        return Buffer.concat([l, td, c]);
      };
      const w = 128, h = 128;
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
      const raw = Buffer.alloc(h * (1 + w * 3));
      for (let y = 0; y < h; y++) {
        const o = y * (1 + w * 3);
        for (let x = 0; x < w; x++) { raw[o+1+x*3] = 220; raw[o+2+x*3] = 30; raw[o+3+x*3] = 30; } // 红
      }
      const png = Buffer.concat([
        Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
      ]);
      const b64 = png.toString('base64');

      const imgMsg = mkMsg({ scope, scopeType: 'private', text: '这是什么颜色', userId: USER_QQ, selfId: BOT_QQ });
      imgMsg.segments = [
        { type: 'text', data: { text: '这是什么颜色' } },
        { type: 'image', data: { file: `base64://${b64}` } },
      ];

      const rImg = await pipeline.handle(imgMsg, napcat.api);
      check('图片: 成功回复', rImg.replied === true, rImg.reason ?? '');
      const said = rImg.content ?? '';
      console.log(`  ℹ 看图回复: ${JSON.stringify(said.slice(0, 80))}`);

      // 注意：这里**不**断言"必须答对颜色"。
      // 实测 deepseek-flash 对纯色小图的判断不稳定，且会被人格提示词干扰
      // （猫娘人格名叫「小白」，提示词里全是白猫意象，容易答"白色"）。
      // 图片是否真的发出去了，由单元测试里对请求体形状的断言来保证（确定性）；
      // 这里只验证"整条链路能带着图片正常跑通并返回内容"。
      check('图片: 回复非空', said.trim().length > 0, said.slice(0, 40));
      const namedColor = /红|橙|黄|绿|蓝|紫|黑|白|灰|粉|red|orange|yellow|green|blue|purple|black|white/i.test(said);
      console.log(`  ℹ 模型是否给出颜色词: ${namedColor ? '是' : '否'}（模型判断不稳定，不作断言）`);
    }
  }

  // ---- 命令 ----
  // 这里模拟一个「管理员用户」的命令上下文（门禁判定在 TriggerPolicy 里，
  // 单独在 stage7 覆盖；此处专注于命令本身的行为）
  const adminCtx = {
    scope,
    scopeType: 'private' as const,
    userId: USER_QQ,
    senderName: '小明',
    isAdmin: true,
    canUseCommands: true,
    canSwitchPersona: true,
  };
  const helpResult = await commands.tryHandle('/help', adminCtx);
  check('命令: /help 有响应', helpResult.handled && (helpResult.reply?.includes('命令') ?? false));

  const personaResult = await commands.tryHandle('/persona cool', adminCtx);
  check('命令: 切换人格成功', personaResult.handled && (personaResult.reply?.includes('冷酷') ?? false), personaResult.reply?.slice(0, 60));
  check('命令: 人格已实际切换', personaMgr.resolve(scope, USER_QQ).persona.id === 'cool');

  const memResult = await commands.tryHandle('/memory', adminCtx);
  check('命令: /memory 返回记忆', memResult.handled && (memResult.reply?.length ?? 0) > 10, memResult.reply?.slice(0, 80));

  const emoResult = await commands.tryHandle('/emotion', adminCtx);
  check('命令: /emotion 返回情绪状态', emoResult.handled && (emoResult.reply?.includes('情绪') ?? false), emoResult.reply?.slice(0, 60));

  const listResult = await commands.tryHandle('/personas', adminCtx);
  check('命令: /personas 列出人格', listResult.handled && (listResult.reply?.includes('catgirl') ?? false));

  // 非管理员：应被门禁拦住
  const deniedCtx = { ...adminCtx, isAdmin: false, canUseCommands: false, canSwitchPersona: false, denyReason: '命令仅限管理员使用' };
  const denied = await commands.tryHandle('/help', deniedCtx);
  check('命令: 非管理员被拒绝', denied.handled === true && (denied.reply?.includes('没有权限') ?? false), denied.reply?.slice(0, 60));

  // 非命令不拦截
  const notCmd = await commands.tryHandle('你好', adminCtx);
  check('非命令不拦截', notCmd.handled === false);

  // ---- 用 cool 人格再聊一次，验证人格生效 ----
  const r5 = await pipeline.handle(
    mkMsg({ scope, scopeType: 'private', text: '解释一下什么是递归', userId: USER_QQ, selfId: BOT_QQ }),
    napcat.api,
  );
  check('端到端: 切换人格后回复正常', r5.replied === true, r5.reason ?? '');
  check('端到端: 使用了新人格', r5.personaId === 'cool', r5.personaId);
  console.log(`  ℹ 用户: 解释一下什么是递归`);
  console.log(`  ℹ 冷酷: ${r5.content?.slice(0, 100)}`);

  // ---- 上下文压缩端到端 ----
  const cscope = 'group:800099';
  personaMgr.setForSession(cscope, 'catgirl');
  store.touchSession(cscope, 'group', 800099, '压缩验证群');
  for (let i = 0; i < 60; i++) {
    store.addMessage({
      scope: cscope,
      userId: USER_QQ,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第${i}轮对话的内容，为了制造足够的token占用，这里写长一点。`.repeat(2),
      senderName: '测试',
    });
  }
  check('压缩: 触发条件满足', cb.shouldCompress(cscope) === true, `${store.countUnsummarized(cscope)} 条未摘要`);

  const compressResult = await cb.compress(cscope, async (messages) => {
    const res = await providersMgr.chat(
      [
        { role: 'system', content: '把对话压缩成简短要点，每条以「- 」开头，200字内。' },
        { role: 'user', content: messages.map((m) => `${m.role === 'assistant' ? 'AI' : '用户'}: ${m.content}`).join('\n').slice(0, 4000) },
      ],
      cfg.llm.defaultProvider,
      undefined,
      // 用与生产一致的预算。推理模型会先输出思维链，
      // 预算给太小会导致正文为空（压缩静默失效），所以这里不能给 400。
      { temperature: 0.2, maxTokens: cfg.llm.generation.summaryMaxTokens },
    );
    return res.content;
  });

  check('压缩: 执行成功', compressResult.ok === true, compressResult.error ?? '');
  check('压缩: 有消息被摘要', (compressResult.summarized ?? 0) > 0, `${compressResult.summarized}`);
  check('压缩: 摘要已落库', store.getSummaries(cscope, 1).length > 0);
  check('压缩: 未摘要计数下降', store.countUnsummarized(cscope) < 60, `${store.countUnsummarized(cscope)}`);
  const summaryRow = store.getSummaries(cscope, 1)[0];
  console.log(`  ℹ 摘要: ${summaryRow?.content.slice(0, 120)}`);

  // 压缩后上下文仍可用
  const afterCompress = cb.build({ scope: cscope, userId: USER_QQ, systemPrompt: '你是助手', userMessage: '继续', contextWindow: 32768 });
  check('压缩: 之后仍能构建上下文', afterCompress.messages.length >= 2);
  const summaryBlock = cb.buildSummaryBlock(cscope);
  check('压缩: 摘要块可注入 prompt', summaryBlock.length > 0, `${summaryBlock.length} 条`);

  // ---- 主动发言决策 ----
  // 注意：显式清空 quietHours，否则测试结果会随运行时刻变化
  // （默认配置 23:00-08:00 免打扰，晚上跑就会全部被拦下）。
  // 免打扰本身的逻辑在上面的 isQuietHour 单元测试里已单独覆盖。
  //
  // 概率为 1 / 0 时行为是确定的，所以下面用它们做确定性断言，
  // 概率本身的行为另有专门用例覆盖。
  const base = {
    ...cfg.proactive,
    enabled: true,
    minIntervalMs: 0,
    minGapAfterBotMs: 0,
    relevanceThreshold: 0.1,
    quietHours: [],
  };
  const proactive = new ProactiveSpeaker(
    { ...base, mode: 'relevant', relevanceProbability: 1 },
    store,
    log,
  );
  const pd = proactive.decide({
    scope: gscope,
    scopeType: 'group',
    recentMessages: [{ senderName: '张三', text: '可乐真好喝', timestamp: Date.now() }],
    lastBotMessageAt: 0,
    relevance: 0.9,
    addressed: false,
    messagesSinceBot: 1,
  });
  check('主动发言: 高相关度时允许', pd.speak === true, pd.speak === false ? pd.reason : '');
  check('主动发言: 相关策略标记正确', pd.speak === true && pd.strategy === 'relevant');

  const pd2 = proactive.decide({
    scope: gscope,
    scopeType: 'group',
    recentMessages: [{ senderName: '张三', text: '随便聊聊', timestamp: Date.now() }],
    lastBotMessageAt: 0,
    relevance: 0.05,
    addressed: false,
    messagesSinceBot: 999,
  });
  check('主动发言: 低相关度时拒绝', pd2.speak === false, pd2.speak === false ? pd2.reason : '');
  check('主动发言: relevant 模式不因消息条数多而放行',
    pd2.speak === false && pd2.reason.includes('相关度不足'), pd2.speak === false ? pd2.reason : '');

  const pd3 = proactive.decide({
    scope,
    scopeType: 'private',
    recentMessages: [{ senderName: '小明', text: 'hi', timestamp: Date.now() }],
    lastBotMessageAt: 0,
    relevance: 1,
    addressed: true,
    messagesSinceBot: 999,
  });
  check('主动发言: 私聊不走主动发言', pd3.speak === false);

  // ---- 概率可调：相关度再高，概率为 0 也不发 ----
  const zeroProb = new ProactiveSpeaker(
    { ...base, mode: 'relevant', relevanceProbability: 0 },
    store,
    log,
  );
  const pz = zeroProb.decide({
    scope: gscope,
    scopeType: 'group',
    recentMessages: [{ senderName: '张三', text: '可乐', timestamp: Date.now() }],
    lastBotMessageAt: 0,
    relevance: 1,
    addressed: false,
    messagesSinceBot: 999,
  });
  check('主动发言: 概率 0 时相关也不发', pz.speak === false, pz.speak === false ? pz.reason : '');
  check('主动发言: 概率 0 的原因里带概率值', pz.speak === false && pz.reason.includes('p=0'));

  // ---- 「每几句消息」策略 ----
  const pscope = 'group:920001';
  const byCount = new ProactiveSpeaker(
    { ...base, mode: 'probability', everyNMessages: 5, probability: 1, relevanceThreshold: 0.9 },
    store,
    log,
  );
  const mkCtx = (n: number, relevance = 0) => ({
    scope: pscope,
    scopeType: 'group' as const,
    recentMessages: [{ senderName: '张三', text: '随便聊聊', timestamp: Date.now() }],
    lastBotMessageAt: 0,
    relevance,
    addressed: false,
    messagesSinceBot: n,
  });

  check('每几句消息: 不到 N 条不发', byCount.decide(mkCtx(4)).speak === false);
  const hitN = byCount.decide(mkCtx(5));
  check('每几句消息: 正好 N 条且概率 1 → 发', hitN.speak === true, hitN.speak === false ? hitN.reason : '');
  check('每几句消息: 策略标记为 probability', hitN.speak === true && hitN.strategy === 'probability');
  check('每几句消息: 非判定点（N+1）不发', byCount.decide(mkCtx(6)).speak === false);
  check('每几句消息: 中间条数都不发（7/8/9）',
    [7, 8, 9].every((n) => byCount.decide(mkCtx(n)).speak === false));
  const hit2N = byCount.decide(mkCtx(10));
  check('每几句消息: 第二个判定点（2N）也发', hit2N.speak === true, hit2N.speak === false ? hit2N.reason : '');

  // everyNMessages 可调
  const byCount3 = new ProactiveSpeaker(
    { ...base, mode: 'probability', everyNMessages: 3, probability: 1 },
    store,
    log,
  );
  check('每几句消息: N 可调（N=3 时第 3 条就发）', byCount3.decide(mkCtx(3)).speak === true);
  check('每几句消息: N=3 时第 2 条不发', byCount3.decide(mkCtx(2)).speak === false);

  const zeroCount = new ProactiveSpeaker(
    { ...base, mode: 'probability', everyNMessages: 5, probability: 0 },
    store,
    log,
  );
  check('每几句消息: 概率 0 时到点也不发', zeroCount.decide(mkCtx(5)).speak === false);

  // ---- hybrid：相关用高概率，不相关用基础概率 ----
  const hybrid = new ProactiveSpeaker(
    { ...base, mode: 'hybrid', everyNMessages: 5, probability: 0, relevanceProbability: 1, relevanceThreshold: 0.6 },
    store,
    log,
  );
  const hRel = hybrid.decide(mkCtx(5, 0.9));
  check('hybrid: 相关时走相关概率', hRel.speak === true && hRel.strategy === 'relevant', hRel.speak === false ? hRel.reason : '');
  check('hybrid: 不相关时走基础概率（基础为 0 → 不发）', hybrid.decide(mkCtx(5, 0.1)).speak === false);

  const hybrid2 = new ProactiveSpeaker(
    { ...base, mode: 'hybrid', everyNMessages: 5, probability: 1, relevanceProbability: 0, relevanceThreshold: 0.6 },
    store,
    log,
  );
  check('hybrid: 相关但相关概率为 0 → 不发', hybrid2.decide(mkCtx(5, 0.9)).speak === false);
  const hBase = hybrid2.decide(mkCtx(10, 0.1));
  check('hybrid: 不相关时用基础概率（为 1 → 发）', hBase.speak === true && hBase.strategy === 'probability');

  // ---- probability 模式不看相关度 ----
  const probOnly = new ProactiveSpeaker(
    { ...base, mode: 'probability', everyNMessages: 5, probability: 1, relevanceProbability: 1, relevanceThreshold: 0.6 },
    store,
    log,
  );
  const po = probOnly.decide(mkCtx(5, 0.99));
  check('probability 模式：话题相关也仍走概率路径', po.speak === true && po.strategy === 'probability');

  // ---- 硬闸门：机器人刚说完话 ----
  const gap = new ProactiveSpeaker(
    { ...base, mode: 'relevant', relevanceProbability: 1, minGapAfterBotMs: 600000 },
    store,
    log,
  );
  const gd = gap.decide({
    ...mkCtx(999, 1),
    lastBotMessageAt: Date.now() - 1000,
  });
  check('硬闸门: 机器人刚说过话时不发', gd.speak === false, gd.speak === false ? gd.reason : '');
  check('硬闸门: 原因说明还需等待', gd.speak === false && gd.reason.includes('刚说过话'));

  // ---- 硬闸门：每小时上限 ----
  const capped = new ProactiveSpeaker(
    { ...base, mode: 'relevant', relevanceProbability: 1, maxPerHourPerScope: 2 },
    store,
    log,
  );
  const capScope = 'group:920002';
  capped.record(capScope, 't', 'a');
  capped.record(capScope, 't', 'b');
  const cd = capped.decide({ ...mkCtx(999, 1), scope: capScope });
  check('硬闸门: 达到每小时上限后不发', cd.speak === false, cd.speak === false ? cd.reason : '');
  check('硬闸门: 原因说明已达上限', cd.speak === false && cd.reason.includes('上限'));

  // ---- 每小时上限 = 0 表示**不限制**（跟另外两个频率闸门语义一致）----
  // 注意这里守的是一个真实踩过的坑：早先 0 会让 `recentCount >= 0` 恒真，
  // 于是"设成 0"变成"永远不发言"，跟 minIntervalMs=0 的含义正好相反。
  const uncapped = new ProactiveSpeaker(
    { ...base, mode: 'relevant', relevanceProbability: 1, maxPerHourPerScope: 0 },
    store,
    log,
  );
  const noCapScope = 'group:920008';
  for (let i = 0; i < 30; i++) uncapped.record(noCapScope, 't', `spam${i}`);
  check('硬闸门: 上限为 0 时记录了 30 次', store.countProactiveSince(noCapScope, Date.now() - 3600_000) === 30,
    String(store.countProactiveSince(noCapScope, Date.now() - 3600_000)));
  const un = uncapped.decide({ ...mkCtx(999, 1), scope: noCapScope });
  check('硬闸门: 上限为 0 = 不限制（一小时发了 30 次仍可发）', un.speak === true, un.speak === false ? un.reason : '');

  // 对照片：上限为 1 时，发过 1 次就该被拦（确认上面不是"恰好没触发"）
  const oneCap = new ProactiveSpeaker(
    { ...base, mode: 'relevant', relevanceProbability: 1, maxPerHourPerScope: 1 },
    store,
    log,
  );
  const oneScope = 'group:920009';
  oneCap.record(oneScope, 't', 'x');
  check('硬闸门: 上限为 1 时发过就拦',
    oneCap.decide({ ...mkCtx(999, 1), scope: oneScope }).speak === false);

  // 三个频率闸门对 0 的解释必须一致
  check('语义一致: minIntervalMs=0 不拦', new ProactiveSpeaker(
    { ...base, mode: 'relevant', relevanceProbability: 1, minIntervalMs: 0, maxPerHourPerScope: 0 },
    store, log,
  ).decide({ ...mkCtx(999, 1), scope: 'group:920010' }).speak === true);
  check('语义一致: minGapAfterBotMs=0 不拦', new ProactiveSpeaker(
    { ...base, mode: 'relevant', relevanceProbability: 1, minGapAfterBotMs: 0, maxPerHourPerScope: 0 },
    store, log,
  ).decide({ ...mkCtx(999, 1), scope: 'group:920011', lastBotMessageAt: Date.now() }).speak === true);

  // 频率限制：用带真实间隔的配置验证（record 后应被冷却拦住）
  const proactiveLimited = new ProactiveSpeaker(
    { ...cfg.proactive, enabled: true, mode: 'relevant', minIntervalMs: 600000, minGapAfterBotMs: 0, relevanceThreshold: 0.1, relevanceProbability: 1 },
    store,
    log,
  );
  const lscope = 'group:920003';
  proactiveLimited.record(lscope, 'test', '主动说了一句话');
  const pd4 = proactiveLimited.decide({
    scope: lscope,
    scopeType: 'group',
    recentMessages: [{ senderName: '张三', text: '可乐', timestamp: Date.now() }],
    lastBotMessageAt: 0,
    relevance: 0.9,
    addressed: false,
    messagesSinceBot: 999,
  });
  check('主动发言: 记录后受频率限制', pd4.speak === false, pd4.speak === false ? pd4.reason : '');

  // ---- 计数来自数据库：countUserMessagesSince / getLastAssistantAt ----
  const cscope2 = 'group:920004';
  store.touchSession(cscope2, 'group', 920004, '计数测试群');
  check('计数: 没有消息时为 0', store.countUserMessagesSinceLastAssistant(cscope2) === 0);
  check('计数: 没说过话时 getLastAssistantAt 为 0', store.getLastAssistantAt(cscope2) === 0);
  for (let i = 0; i < 3; i++) {
    store.addMessage({ scope: cscope2, userId: 1, role: 'user', content: `msg${i}`, senderName: '甲' });
  }
  check('计数: 统计到 3 条用户消息', store.countUserMessagesSinceLastAssistant(cscope2) === 3, String(store.countUserMessagesSinceLastAssistant(cscope2)));
  store.addMessage({ scope: cscope2, userId: 2, role: 'assistant', content: 'bot reply', senderName: 'AI' });
  const lastAt = store.getLastAssistantAt(cscope2);
  check('计数: 取到机器人发言时间', lastAt > 0);
  check('计数: 机器人发言后计数归零', store.countUserMessagesSinceLastAssistant(cscope2) === 0, String(store.countUserMessagesSinceLastAssistant(cscope2)));
  store.addMessage({ scope: cscope2, userId: 1, role: 'user', content: 'after', senderName: '甲' });
  // 按 id 计数，所以同一毫秒内插入也不会漏（按时间戳会漏，这是踩过的坑）
  check('计数: 发言后新消息被计入（同毫秒也不会漏）', store.countUserMessagesSinceLastAssistant(cscope2) === 1);
  store.addMessage({ scope: cscope2, userId: 1, role: 'user', content: 'same-ms', senderName: '甲' });
  check('计数: 同毫秒插入也被 id 计数捕捉到', store.countUserMessagesSinceLastAssistant(cscope2) === 2);

  // ---- evaluate()：从数据库读计数并做决定（这是 index.ts 真正调用的入口）----
  const escope = 'group:920005';
  const ev = new ProactiveSpeaker(
    { ...base, mode: 'probability', everyNMessages: 4, probability: 1 },
    store,
    log,
  );
  store.touchSession(escope, 'group', 920005, '评估测试群');
  const pushMsg = (text: string) =>
    store.addMessage({ scope: escope, userId: 7, role: 'user', content: text, senderName: '甲' });

  const evalHits: number[] = [];
  for (let i = 1; i <= 8; i++) {
    pushMsg(`第 ${i} 条`);
    const d = ev.evaluate(escope, 920005, false);
    if (d.speak) evalHits.push(i);
  }
  check('evaluate: 每 4 条命中一次（第 4、8 条）', JSON.stringify(evalHits) === '[4,8]', JSON.stringify(evalHits));

  // 机器人发言后计数归零，重新从 1 开始数
  store.addMessage({ scope: escope, userId: 8, role: 'assistant', content: 'bot 说了一句', senderName: 'AI' });
  const afterBot: number[] = [];
  for (let i = 1; i <= 4; i++) {
    pushMsg(`发言后第 ${i} 条`);
    const d = ev.evaluate(escope, 920005, false);
    if (d.speak) afterBot.push(i);
  }
  check('evaluate: 机器人发言后计数归零，重新从第 4 条命中', JSON.stringify(afterBot) === '[4]', JSON.stringify(afterBot));

  // 没有用户消息时不发言
  const quiet = 'group:920006';
  store.touchSession(quiet, 'group', 920006, '空群');
  const qd = ev.evaluate(quiet, 920006, false);
  check('evaluate: 群里没有消息时不发言', qd.speak === false, qd.speak === false ? qd.reason : '');

  // evaluate 全程同步，不需要重入锁；这里确认连续调用互不影响
  const rscope = 'group:920007';
  store.touchSession(rscope, 'group', 920007, '连续调用群');
  const ev2 = new ProactiveSpeaker(
    { ...base, mode: 'probability', everyNMessages: 3, probability: 1 },
    store,
    log,
  );
  const seq: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    store.addMessage({ scope: rscope, userId: 9, role: 'user', content: `x${i}`, senderName: '乙' });
    seq.push(ev2.evaluate(rscope, 920007, false).speak);
  }
  check('evaluate: 连续调用各看各的计数（false,false,true）', JSON.stringify(seq) === '[false,false,true]', JSON.stringify(seq));

  // ---- 旧 mode 值迁移 ----
  const legacy1 = { proactive: { mode: 'random' } } as Record<string, unknown>;
  migrateLegacyAppConfig(legacy1);
  check('迁移: random → probability', (legacy1['proactive'] as Record<string, unknown>)['mode'] === 'probability');
  const legacy2 = { proactive: { mode: 'mention-only-when-relevant' } } as Record<string, unknown>;
  migrateLegacyAppConfig(legacy2);
  check('迁移: mention-only-when-relevant → relevant', (legacy2['proactive'] as Record<string, unknown>)['mode'] === 'relevant');
  const legacy3 = { proactive: { mode: 'hybrid' } } as Record<string, unknown>;
  migrateLegacyAppConfig(legacy3);
  check('迁移: 新值保持不变', (legacy3['proactive'] as Record<string, unknown>)['mode'] === 'hybrid');
  check('迁移: 没有 proactive 段也不炸', (() => {
    try { migrateLegacyAppConfig({}); migrateLegacyAppConfig(null); migrateLegacyAppConfig({ proactive: null }); return true; } catch { return false; }
  })());

  // ---- 相关度计算 ----
  store.addFact({ userId: USER_QQ, scope: gscope, factType: 'preference', content: '用户喜欢喝无糖可乐', keywords: '无糖 可乐 喜欢', confidence: 0.9, shareable: true });
  const rel = proactive.computeRelevance(gscope, [USER_QQ], '大家觉得无糖可乐好喝吗');
  check('相关度计算: 命中记忆关键词得分>0', rel > 0, String(rel));
  const relNone = proactive.computeRelevance(gscope, [USER_QQ], '今天天气真不错啊');
  check('相关度计算: 无关内容得分低', relNone < rel, `${relNone} vs ${rel}`);

  // ---- 清理 ----
  napcat.stop();
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
}

function mkMsg(o: {
  scope: string;
  scopeType: 'private' | 'group';
  text: string;
  userId: number;
  selfId: number;
  groupId?: number;
  mentionsBot?: boolean;
}): Parameters<ReplyPipeline['handle']>[0] {
  const msg: Parameters<ReplyPipeline['handle']>[0] = {
    scope: o.scope,
    scopeType: o.scopeType,
    userId: o.userId,
    messageId: Math.floor(Math.random() * 1e6),
    selfId: o.selfId,
    text: o.text,
    segments: [{ type: 'text', data: { text: o.text } }],
    mentionsBot: o.mentionsBot ?? false,
    senderName: o.scopeType === 'group' ? '群里的测试用户' : '测试用户',
    timestamp: Date.now(),
    raw: {} as never,
  };
  if (o.groupId !== undefined) msg.groupId = o.groupId;
  return msg;
}

function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待超时: ${label}`));
      }
    }, 50);
  });
}

// ============================================================
async function main(): Promise<void> {
  process.env.LOG_LEVEL = 'error';

  console.log('========================================');
  console.log('  阶段 3/4/5 验证：人格 · 记忆 · 情绪 · 压缩');
  console.log('========================================');

  const loaded = loadConfig();
  const cfg = loaded.app;
  const tmpDb = path.join(os.tmpdir(), `qqagent-test-${Date.now()}.db`);
  const store = new MemoryStore(tmpDb);

  try {
    testPersona(store, cfg, loaded.personas);
    testTrigger(cfg);
    testEmotionRule();
    testMemory(store);
    testUtils();
    testContext(cfg, store);
    await testEndToEnd(cfg, loaded.providers, loaded.personas, store);
  } finally {
    store.close();
    // 清理临时数据库
    for (const suffix of ['', '-wal', '-shm']) {
      const f = tmpDb + suffix;
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }

  console.log('\n========================================');
  console.log(`  结果: ${pass} 通过, ${fail} 失败, ${skip} 跳过`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试异常:', e);
  process.exit(1);
});
