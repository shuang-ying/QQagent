/**
 * 阶段 2 验证：任意 API 接入 + 模型自动发现
 *
 * 包含真实网络测试（使用你已配置的中转站）与离线健壮性测试。
 * 运行：npm run test:stage2
 */
import { discoverModels, testChat } from '../src/llm/discover.js';
import { LlmClient } from '../src/llm/client.js';
import { inferModelMeta, candidateApiRoots } from '../src/llm/protocol.js';
import { normalizeBaseUrl, loadConfig, resolveApiKey } from '../src/config/loader.js';
import { getLogger } from '../src/core/logger.js';

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
// 离线测试：URL 归一化、协议推导、模型元数据推断
// ============================================================
function testOffline(): void {
  section('URL 归一化（用户可能粘贴各种形式的地址）');

  check('去掉尾部斜杠', normalizeBaseUrl('https://api.x.com/v1/') === 'https://api.x.com/v1');
  check(
    '剥掉完整 chat/completions 端点',
    normalizeBaseUrl('https://api.x.com/v1/chat/completions') === 'https://api.x.com/v1',
    normalizeBaseUrl('https://api.x.com/v1/chat/completions'),
  );
  check('剥掉 /models 后缀', normalizeBaseUrl('https://api.x.com/v1/models') === 'https://api.x.com/v1');
  check('剥掉 anthropic /messages', normalizeBaseUrl('https://api.x.com/v1/messages') === 'https://api.x.com/v1');
  check('保留无版本路径', normalizeBaseUrl('https://api.x.com') === 'https://api.x.com');

  section('API 根路径候选推导');

  const r1 = candidateApiRoots('https://api.x.com');
  check('无版本号时补 /v1', r1.includes('https://api.x.com/v1'), r1.join(' | '));
  check('无版本号时补 /v1beta', r1.includes('https://api.x.com/v1beta'), r1.join(' | '));

  const r2 = candidateApiRoots('https://api.x.com/v1');
  check('已有 /v1 时不重复添加', r2.filter((x) => x.endsWith('/v1')).length === 1, r2.join(' | '));

  const r3 = candidateApiRoots('http://127.0.0.1:11434/api');
  check('处理 /api 结尾', r3.some((x) => x.endsWith('/v1')), r3.join(' | '));

  section('模型元数据推断');

  const claude = inferModelMeta('[AN]claude-sonnet-4-6');
  check('Claude: 识别 anthropic 标签', claude.tags.includes('anthropic'), claude.tags.join(','));
  check('Claude: 上下文 200k', claude.contextWindow === 200000, String(claude.contextWindow));
  check('Claude: 支持 vision', claude.supportsVision === true);

  const gem = inferModelMeta('gemini-3.7-flash');
  check('Gemini: 识别 google 标签', gem.tags.includes('google'));
  check('Gemini: 上下文 1M', gem.contextWindow === 1000000, String(gem.contextWindow));

  const emb = inferModelMeta('gemini-embedding-2');
  check('Embedding: 打上 embedding 标签', emb.tags.includes('embedding'), emb.tags.join(','));
  check('Embedding: 不支持流式', emb.supportsStream === false);

  const img = inferModelMeta('nai-diffusion-5-full:k_dpmpp_2m');
  check('绘图模型: 打上 image 标签', img.tags.includes('image'), img.tags.join(','));
  check('绘图模型: 不支持 tools', img.supportsTools === false);

  const think = inferModelMeta('deepseek-v4-pro-thinking');
  check('推理模型: 打上 reasoning 标签', think.tags.includes('reasoning'), think.tags.join(','));

  check('DeepSeek: 识别供应商', inferModelMeta('deepseek-v4.1-flash').tags.includes('deepseek'));

  section('错误处理（离线健壮性）');

  // 这些是异步的，放到 main 里做
}

async function testOfflineAsync(): Promise<void> {
  section('错误处理：不可达地址 / 错误 Key');

  // 1) 域名不存在
  const bad = await discoverModels({
    baseURL: 'https://this-domain-definitely-does-not-exist-12345.invalid/v1',
    apiKey: 'sk-test',
    timeoutMs: 8000,
  });
  check('不存在的域名: 返回失败而非抛异常', bad.ok === false);
  check('不存在的域名: 有错误说明', !!bad.error, bad.error);
  check('不存在的域名: 记录了探测轨迹', bad.attempts.length > 0, `${bad.attempts.length} 次`);
  check(
    '不存在的域名: 提示信息可读',
    bad.attempts.some((a) => /域名解析失败|连接|超时/.test(a.note)),
    bad.attempts[0]?.note,
  );

  // 2) 连接被拒绝（本地未监听端口）
  const refused = await discoverModels({
    baseURL: 'http://127.0.0.1:59999/v1',
    apiKey: 'sk-test',
    timeoutMs: 5000,
  });
  check('连接被拒绝: 返回失败', refused.ok === false);
  check(
    '连接被拒绝: 提示"服务未启动"',
    refused.attempts.some((a) => /连接被拒绝/.test(a.note)),
    refused.attempts[0]?.note,
  );
}

// ============================================================
// 真实网络测试：使用当前配置里的默认供应商
// （不假设任何特定中转站，换供应商后依然可用）
// ============================================================
async function testRealRelay(): Promise<void> {
  section('真实供应商：模型自动发现');

  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    check('加载配置', false, (e as Error).message);
    return;
  }

  // 默认用配置里的默认供应商；可用 TEST_PROVIDER=xxx 指定另一个，
  // 便于默认供应商临时故障时仍能验证代码本身。
  const key = process.env.TEST_PROVIDER || cfg.app.llm.defaultProvider || Object.keys(cfg.providers)[0] || '';
  const p = cfg.providers[key];
  if (!p) {
    skipping('真实网络测试', '配置里没有任何 provider');
    return;
  }
  const apiKey = resolveApiKey(p);
  if (!apiKey && p.protocol !== 'ollama') {
    skipping('真实网络测试', `${key} 未解析到 API Key`);
    return;
  }

  console.log(`  ℹ 供应商: ${key}`);
  console.log(`  ℹ 地址: ${p.baseURL}`);
  console.log(`  ℹ 密钥: ${apiKey ? apiKey.slice(0, 6) + '***' + apiKey.slice(-4) : '(无)'}`);

  const t0 = Date.now();
  const result = await discoverModels({
    baseURL: p.baseURL,
    apiKey,
    protocol: p.protocol,
    headers: p.headers,
    timeoutMs: 30000,
  });
  const elapsed = Date.now() - t0;

  check('自动发现成功', result.ok === true, result.error);
  check('返回了模型列表', result.models.length > 0, `${result.models.length} 个`);
  check('协议已识别（非 auto）', result.protocol !== ('auto' as never), result.protocol);
  console.log(`  ℹ 发现 ${result.models.length} 个模型，耗时 ${elapsed}ms`);

  if (result.models.length > 0) {
    const ids = result.models.map((m) => m.id);
    console.log(`  ℹ 样例: ${ids.slice(0, 6).join(', ')}`);

    check('模型列表: 无重复 id', new Set(ids).size === ids.length);
    check('模型列表: 均有 id', result.models.every((m) => !!m.id));
    check('模型列表: 均带标签', result.models.every((m) => Array.isArray(m.tags)));
    check(
      '模型列表: 至少一个模型有上下文窗口',
      result.models.some((m) => typeof m.contextWindow === 'number' && m.contextWindow > 0),
    );
    check('探测轨迹: 记录了成功的端点', result.attempts.some((a) => a.ok));
  }

  // 选一个可用模型做后续对话测试：优先配置的默认模型
  const pickModel =
    (cfg.app.llm.defaultModel && result.models.some((m) => m.id === cfg.app.llm.defaultModel)
      ? cfg.app.llm.defaultModel
      : '') ||
    result.models.find((m) => /deepseek|gpt|claude|qwen|glm/i.test(m.id))?.id ||
    result.models[0]?.id ||
    '';

  if (!pickModel) {
    skipping('真实对话测试', '没有可用模型');
    return;
  }
  console.log(`  ℹ 用于对话测试的模型: ${pickModel}`);

  section('真实供应商：流式对话');

  const model = pickModel;
  // 用发现出来的协议，而不是写死 openai
  const proto: Exclude<import('../src/core/types.js').Protocol, 'auto'> =
    result.protocol === ('auto' as never) ? 'openai' : result.protocol;
  const client = new LlmClient(getLogger('test'));
  let streamed = '';
  let chunks = 0;
  let streamResult;
  try {
    const gen = client.streamChat([{ role: 'user', content: '从1数到5，只输出数字，用空格分隔' }], {
      baseURL: p.baseURL,
      apiKey,
      model,
      protocol: proto,
      temperature: 0.1,
      // 推理模型需要足够预算输出思维链 + 正文，给小了正文会是空的
      maxTokens: 512,
      stream: true,
      timeoutMs: 60000,
    });
    while (true) {
      const step = await gen.next();
      if (step.done) {
        streamResult = step.value;
        break;
      }
      streamed += step.value;
      chunks++;
    }
  } catch (e) {
    check('流式对话: 无异常', false, (e as Error).message);
    return;
  }

  check('流式对话: 收到内容', streamed.length > 0, `长度 ${streamed.length}`);
  check('流式对话: 分多个增量块（确认是流式而非一次性）', chunks > 1, `${chunks} 块`);
  check('流式对话: 内容含数字', /\d/.test(streamed), streamed.slice(0, 80));
  console.log(`  ℹ 流式输出(${chunks}块): ${JSON.stringify(streamed.slice(0, 120))}`);

  if (streamResult) {
    check('流式对话: 返回统计信息', !!streamResult.usage);
    check('流式对话: 记录了耗时', streamResult.latencyMs > 0);
    console.log(
      `  ℹ 耗时 ${streamResult.latencyMs}ms, tokens: prompt=${streamResult.usage.promptTokens} completion=${streamResult.usage.completionTokens}`,
    );
  }

  section('真实供应商：非流式对话（内部任务用）');

  try {
    const res = await client.chat(
      [
        { role: 'system', content: '你是一个只输出JSON的助手。' },
        { role: 'user', content: '输出这个JSON: {"ok":true,"n":42}  不要任何其他文字' },
      ],
      {
        baseURL: p.baseURL,
        apiKey,
        model,
        protocol: proto,
        temperature: 0,
        maxTokens: 100,
        stream: false,
        timeoutMs: 60000,
      },
    );
    check('非流式对话: 收到内容', res.content.length > 0, res.content.slice(0, 100));
    check('非流式对话: 内容含 JSON 特征', /ok/.test(res.content), res.content.slice(0, 100));
    console.log(`  ℹ 返回: ${JSON.stringify(res.content.slice(0, 100))}`);
  } catch (e) {
    check('非流式对话: 无异常', false, (e as Error).message);
  }

  section('真实供应商：错误 Key 的处理');

  const badKey = await discoverModels({
    baseURL: p.baseURL,
    apiKey: 'sk-invalid-key-for-testing-000000000000',
    protocol: proto,
    timeoutMs: 20000,
  });
  check('错误 Key: 发现失败', badKey.ok === false);
  check(
    '错误 Key: 提示鉴权问题',
    badKey.attempts.some((a) => a.status === 401 || a.status === 403),
    badKey.attempts.map((a) => `${a.status}`).join(','),
  );
  console.log(`  ℹ 错误提示: ${badKey.error}`);

  section('真实供应商：连通性自检（面板按钮的底层能力）');

  const tc = await testChat(p.baseURL, apiKey, model, proto);
  check('自检: 对话成功', tc.ok === true, tc.error);
  check('自检: 有回复内容', tc.reply.length > 0, tc.reply.slice(0, 60));
  console.log(`  ℹ 自检回复: ${JSON.stringify(tc.reply.slice(0, 60))} (${tc.latencyMs}ms)`);
}

// ============================================================
async function main(): Promise<void> {
  process.env.LOG_LEVEL = 'error';

  console.log('========================================');
  console.log('  阶段 2 验证：任意 API 接入与模型发现');
  console.log('========================================');

  testOffline();
  await testOfflineAsync();
  await testRealRelay();

  console.log('\n========================================');
  console.log(`  结果: ${pass} 通过, ${fail} 失败, ${skip} 跳过`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试异常:', e);
  process.exit(1);
});
