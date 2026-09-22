/**
 * 阶段 6 验证：Web 管理面板
 * 直接对运行中的面板发请求，验证所有 API 与前端资源。
 *
 * 用法：
 *   1. 先启动 agent（start.bat / npm run dev）
 *   2. npm run test:stage6
 *
 * 可选环境变量：
 *   PANEL_URL  — 面板地址，默认 http://127.0.0.1:3081
 *   PROBE_URL / PROBE_KEY — 额外测一次「临时 URL+Key 搜索模型」，不填则跳过
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const BASE: string = process.env.PANEL_URL || 'http://127.0.0.1:3081';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n【${title}】`);
}

interface ApiResult {
  status: number;
  text: string;
  json: any;
}

async function j(path: string, init?: RequestInit): Promise<ApiResult> {
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（例如 HTML 页面） */
  }
  return { status: r.status, text, json };
}

const post = (p: string, body: unknown): Promise<ApiResult> =>
  j(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  阶段 6 验证：Web 管理面板');
  console.log(`  ${BASE}`);
  console.log('========================================');

  // ---------- 前端资源 ----------
  section('前端页面');
  const page = await j('/');
  check('面板首页返回 200', page.status === 200, String(page.status));
  check('HTML 内容非空', page.text.length > 10000, `${page.text.length} 字节`);
  check('含页面标题', page.text.includes('QQ Agent 管理面板'));
  check(
    '含全部导航项',
    ['概览', '模型接入', '人格', '记忆', '情绪', '日志'].every((k: string) => page.text.includes(k)),
  );
  check('含 UTF-8 编码声明', page.text.includes('charset="UTF-8"'));
  check('含模型搜索界面', page.text.includes('搜索可用模型') && page.text.includes('discUrl'));
  check('前端 JS 已内联', page.text.includes('loadOverview') && page.text.includes('/api/overview'));
  const page2 = await j('/panel');
  check('/panel 路由同样可用', page2.status === 200 && page2.text.length === page.text.length);

  // ---------- 概览 ----------
  section('概览 API');
  const ov = await j('/api/overview');
  check('返回 200', ov.status === 200);
  check('含运行时状态', !!ov.json?.runtime);
  check('NapCat 连接状态为布尔', typeof ov.json?.runtime?.napcatConnected === 'boolean');
  check('含机器人账号', typeof ov.json?.runtime?.selfId === 'number');
  check('含运行时长', typeof ov.json?.runtime?.uptimeMs === 'number' && ov.json.runtime.uptimeMs >= 0);
  check('含数据统计', !!ov.json?.stats && typeof ov.json.stats.users === 'number');
  check(
    '统计字段完整',
    ['users', 'sessions', 'messages', 'facts', 'summaries', 'emotionRecords'].every(
      (k: string) => k in ov.json.stats,
    ),
  );
  check('含功能开关', !!ov.json?.features);
  check('含 token 用量', !!ov.json?.usage && typeof ov.json.usage.totalCalls === 'number');

  // ---------- Providers ----------
  // 注意：不自带任何供应商假设 —— 用当前配置里实际的默认供应商来测，
  // 这样换供应商/换中转站后测试依然成立。
  section('Provider API');
  const pv = await j('/api/providers');
  check('返回 200', pv.status === 200);
  check('有 provider 列表', Array.isArray(pv.json?.providers) && pv.json.providers.length > 0);

  const defaultKey = pv.json.defaultProvider;
  const def = pv.json.providers.find((p: any) => p.key === defaultKey) ?? pv.json.providers[0];
  check('找到默认供应商', !!def, `defaultProvider=${defaultKey}`);
  check('默认供应商被标记', def?.isDefault === true, JSON.stringify(def));
  check(
    '密钥被脱敏显示',
    typeof def?.keyPreview === 'string' && def.keyPreview.includes('***'),
    def?.keyPreview,
  );
  check('密钥未明文返回', !/sk-[A-Za-z0-9]{20,}/.test(JSON.stringify(pv.json)), '面板不应泄露完整密钥');
  check('displayName 可正常解码', typeof def?.displayName === 'string' && def.displayName.length > 0, def?.displayName);
  check('显示缓存模型数', typeof def?.modelCount === 'number', String(def?.modelCount));

  // ---------- 模型发现（核心功能） ----------
  section('模型发现 API（核心功能）');
  const disc = await post('/api/providers/discover', { providerKey: def.key });
  check('返回 200', disc.status === 200);
  check(
    '发现成功或给出可读错误',
    disc.json?.ok === true || (typeof disc.json?.error === 'string' && disc.json.error.length > 0),
    disc.json?.error,
  );
  if (disc.json?.ok) {
    check(
      '返回模型列表',
      Array.isArray(disc.json?.models) && disc.json.models.length > 0,
      `${disc.json?.models?.length}`,
    );
    check('协议已识别', ['openai', 'anthropic', 'gemini', 'ollama'].includes(disc.json?.protocol), disc.json?.protocol);
    check('计数与实际一致', disc.json?.count === disc.json?.models?.length);
    console.log(`  ℹ 发现 ${disc.json?.count} 个模型（${def.key}）`);
  } else {
    console.log(`  ⏭  该供应商暂时无法发现模型：${disc.json?.error}`);
  }
  check('含探测轨迹', Array.isArray(disc.json?.attempts) && disc.json.attempts.length > 0);

  // 用任意（未保存的）URL + Key 直接发现 —— 对应「输入 url + key 搜索模型」
  if (process.env.PROBE_URL && process.env.PROBE_KEY) {
    const disc2 = await post('/api/providers/discover', {
      baseURL: process.env.PROBE_URL,
      apiKey: process.env.PROBE_KEY,
      protocol: 'auto',
    });
    check('临时 URL+Key 直接搜索模型', disc2.json?.ok === true, disc2.json?.error);
    check('临时搜索返回模型', disc2.json?.count > 0);
  } else {
    console.log('  ⏭  临时 URL+Key 搜索 — 未提供 PROBE_URL/PROBE_KEY');
  }

  // 错误地址应给出可读错误
  const bad = await post('/api/providers/discover', { baseURL: 'http://127.0.0.1:59999/v1', apiKey: 'x' });
  check('错误地址返回 ok=false', bad.json?.ok === false);
  check('错误信息可读', typeof bad.json?.error === 'string' && bad.json.error.length > 0, bad.json?.error);
  check('返回失败详情', Array.isArray(bad.json?.attempts) && bad.json.attempts.length > 0);
  check('缺少地址时返回 400', (await post('/api/providers/discover', {})).status === 400);

  // ---------- 人格 ----------
  section('人格 API');
  const ps = await j('/api/personas');
  check('返回 200', ps.status === 200);
  const personaCount = ps.json?.personas?.length ?? 0;
  check('人格列表非空（>=6）', personaCount >= 6, String(personaCount));
  // 不断言具体是哪个 —— 默认人格是用户可改的配置项，
  // 写死 catgirl 会在用户合法地换了默认人格时误报失败。
  check('默认人格是列表里的一个', ps.json.personas.some((p: any) => p.id === ps.json.default),
    String(ps.json?.default));
  const catgirl = ps.json.personas.find((p: any) => p.id === 'catgirl');
  check('猫娘中文名正确', catgirl?.name === '猫娘', catgirl?.name);
  check('猫娘描述正确解码', catgirl?.description?.includes('猫娘'), catgirl?.description);
  check('含 systemPrompt', catgirl?.systemPrompt?.length > 100);
  check('含情绪调制', Object.keys(catgirl?.emotionModulation || {}).length >= 4);
  check('所有 id 唯一', new Set(ps.json.personas.map((p: any) => p.id)).size === personaCount);
  check('含蓝色大肥鱼', ps.json.personas.some((p: any) => p.id === 'blue-fish'));

  const scope = await j('/api/personas/scope');
  check('会话人格 API 可用', scope.status === 200);
  check('返回配置', !!scope.json?.config);

  const setP = await post('/api/personas/scope', { scope: 'group:900001', personaId: 'cool' });
  check('会话人格切换成功', setP.json?.ok === true, JSON.stringify(setP.json));
  const setBad = await post('/api/personas/scope', { scope: 'group:900001', personaId: 'nonexistent' });
  check('拒绝不存在的人格', setBad.json?.ok === false);

  // ---------- 记忆 ----------
  section('记忆 API');
  const us = await j('/api/users');
  check('用户列表返回 200', us.status === 200);
  check('返回数组', Array.isArray(us.json?.users));

  const missing = await j('/api/users/999999999');
  check('不存在的用户返回 404', missing.status === 404);
  const badId = await j('/api/users/notanumber');
  check('非法 QQ 号返回 400', badId.status === 400);

  const search = await j('/api/memory/search?q=test');
  check('记忆搜索返回 200', search.status === 200);
  check('搜索返回 facts 数组', Array.isArray(search.json?.facts));
  check('搜索返回 messages 数组', Array.isArray(search.json?.messages));
  check('空查询不报错', (await j('/api/memory/search?q=')).status === 200);

  const emo = await j('/api/users/12345/emotion');
  check('情绪接口返回 200', emo.status === 200);
  check('情绪返回 history 数组', Array.isArray(emo.json?.history));

  const gm = await j('/api/groups/12345/members');
  check('群成员接口可用', gm.status === 200);
  check('非法群号返回 400', (await j('/api/groups/abc/members')).status === 400);

  const sess = await j('/api/sessions/' + encodeURIComponent('group:900001') + '/messages');
  check('会话消息接口可用', sess.status === 200);
  check('返回 messages 与 summaries', Array.isArray(sess.json?.messages) && Array.isArray(sess.json?.summaries));

  // ---------- 日志 ----------
  section('日志 API');
  const logs = await j('/api/logs?lines=50');
  check('日志返回 200', logs.status === 200);
  check('返回行数组', Array.isArray(logs.json?.lines));
  check('日志非空（有启动记录）', logs.json.lines.length > 0, `${logs.json?.lines?.length} 行`);
  if (logs.json.lines.length > 0) {
    const joined: string = logs.json.lines.join('\n');
    check(
      '日志中文未乱码',
      !/[\uFFFD]/.test(joined) && /QQ Agent|已就绪|连接|模型/.test(joined),
      joined.slice(0, 100),
    );
  }

  // ---------- 安全 ----------
  section('安全');
  const allJson = JSON.stringify([ov.json, pv.json, ps.json, us.json]);
  check('接口不泄露完整 API Key', !/sk-[A-Za-z0-9]{20,}/.test(allJson));

  console.log('\n========================================');
  console.log(`  结果: ${pass} 通过, ${fail} 失败`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('测试异常:', e);
  process.exit(1);
});
