/**
 * 首次配置向导（npm run init）
 *
 * 做三件事：
 *  1. 校验配置能否加载、人格是否齐全
 *  2. 探测 AI API，把可用模型列出来
 *  3. 把选中的 provider / 模型写回配置
 *
 * 非交互式（用于自动化）：
 *   npm run init -- --url https://x/v1 --key sk-xxx [--provider relay] [--model gpt-4o]
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, resolveApiKey, PROJECT_ROOT, ConfigError } from '../src/config/loader.js';
import { discoverModels, testChat } from '../src/llm/discover.js';
import type { Protocol } from '../src/core/types.js';

interface Args {
  url?: string;
  key?: string;
  provider?: string;
  model?: string;
  list?: boolean;
  yes?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--url' && next) out.url = next;
    else if (a === '--key' && next) out.key = next;
    else if (a === '--provider' && next) out.provider = next;
    else if (a === '--model' && next) out.model = next;
    else if (a === '--list') out.list = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
  }
  return out;
}

function line(char = '─', n = 62): string {
  return char.repeat(n);
}

function header(t: string): void {
  console.log('\n' + line());
  console.log('  ' + t);
  console.log(line());
}

/**
 * 把密钥写入项目根目录的 .env（已被 .gitignore 忽略），而不是写进 YAML。
 * 这样 providers.yaml 里只保留 apiKeyEnv 的间接引用，避免明文密钥被误提交。
 */
function writeEnvKey(root: string, varName: string, value: string): void {
  const file = path.join(root, '.env');
  let lines: string[] = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  }

  const re = new RegExp(`^\\s*${varName}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  const entry = `${varName}=${value}`;
  if (idx >= 0) lines[idx] = entry;
  else {
    if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('');
    lines.push(entry);
  }

  fs.writeFileSync(file, lines.join('\r\n').replace(/^(\r\n)+/, ''), 'utf8');
}

/** 把 providers.yaml 里的某个 provider 的 baseURL / protocol 写回文件（不写密钥） */
function writeProvider(
  cfgDir: string,
  providerKey: string,
  patch: { baseURL?: string; protocol?: string; apiKeyEnv?: string },
): void {
  const file = path.join(cfgDir, 'providers.yaml');
  let raw = fs.readFileSync(file, 'utf8');

  const blockRe = new RegExp(`(\\n  ${providerKey}:\\n)([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|\\n?# -{3,}|$)`);
  const m = blockRe.exec(raw);
  if (!m) {
    console.warn(`  ⚠ 未在 providers.yaml 中找到 provider "${providerKey}"，跳过写入。`);
    return;
  }

  let block = m[2] ?? '';
  const setField = (field: string, value: string): void => {
    const re = new RegExp(`^(\\s*${field}:\\s*).*$`, 'm');
    if (re.test(block)) block = block.replace(re, `$1${value}`);
    else block = block.replace(/\n?$/, `\n    ${field}: ${value}\n`);
  };

  if (patch.baseURL !== undefined) setField('baseURL', patch.baseURL);
  if (patch.protocol !== undefined) setField('protocol', patch.protocol);
  if (patch.apiKeyEnv !== undefined) setField('apiKeyEnv', patch.apiKeyEnv);

  raw = raw.slice(0, m.index) + m[1] + block + raw.slice(m.index + m[0].length);
  fs.writeFileSync(file, raw, 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  header('🐱 QQ Agent 配置向导');
  console.log(`  项目目录: ${PROJECT_ROOT}`);

  // ==================== 1. 校验配置 ====================
  header('① 检查配置文件');
  let cfg;
  try {
    cfg = loadConfig();
    console.log('  ✅ config/app.yaml 加载成功');
    console.log('  ✅ config/providers.yaml 加载成功');
    console.log(`  ✅ 已加载 ${cfg.personas.length} 个人格: ${cfg.personas.map((p) => p.id).join(', ')}`);
    console.log(`  ✅ 默认人格: ${cfg.app.persona.default}`);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error('  ❌ ' + e.message);
      process.exit(1);
    }
    throw e;
  }

  console.log(`\n  NapCat 地址 : ${cfg.app.napcat.url}`);
  console.log(`  管理面板    : http://${cfg.app.server.host}:${cfg.app.server.port}`);

  // ==================== 2. 探测 API ====================
  let providerKey = args.provider ?? cfg.app.llm.defaultProvider;
  let prov = providerKey ? cfg.providers[providerKey] : undefined;

  // 没有已配置的 provider 时，从命令行参数创建一个
  if (!prov && args.url) {
    providerKey = args.provider || 'my-api';
    prov = {
      displayName: providerKey,
      protocol: 'auto',
      baseURL: args.url,
      apiKey: args.key || '',
      apiKeyEnv: '',
      models: [],
      discover: { mode: 'auto' },
      headers: {},
      enabled: true,
    };
  }

  if (!prov) {
    console.error(`\n  ❌ 未找到已配置的供应商。`);
    console.error(`     可用供应商: ${Object.keys(cfg.providers).join(', ') || '(无)'}`);
    console.error(`     请通过 --url 和 --key 参数提供 API 地址和密钥，或打开管理面板添加。`);
    process.exit(1);
  }

  const baseURL = args.url ?? prov.baseURL;
  const apiKey = args.key ?? resolveApiKey(prov);

  header(`② 探测 AI API（provider: ${providerKey}）`);
  console.log(`  地址: ${baseURL}`);
  console.log(`  密钥: ${apiKey ? apiKey.slice(0, 6) + '***' + apiKey.slice(-4) : '(未配置)'}`);

  if (!apiKey && prov.protocol !== 'ollama') {
    console.log('\n  ⚠ 未找到 API Key。');
    console.log('    可以：');
    console.log('      1. 在管理面板里填入（推荐）');
    console.log('      2. 在项目根目录建 .env 文件写 ' + (prov.apiKeyEnv || 'API_KEY') + '=sk-xxx');
    console.log('      3. 直接改 config/providers.yaml 的 apiKey 字段');
    console.log('      4. 重跑本向导并加 --key sk-xxx');
    console.log('\n  仍然继续探测（部分服务无需密钥，例如本地 Ollama）…\n');
  }

  const proto = (prov.protocol === 'auto' ? 'auto' : prov.protocol) as Protocol;
  const disc = await discoverModels({ baseURL, apiKey, protocol: proto, timeoutMs: 20000 });

  if (!disc.ok) {
    console.error(`\n  ❌ 未能发现模型`);
    console.error(`     ${disc.error ?? '未知错误'}`);
    if (disc.attempts.length) {
      console.error('\n  探测轨迹:');
      for (const a of disc.attempts) {
        console.error(`    • ${a.url}  →  ${a.status ?? ''} ${a.note}`);
      }
    }
    console.error('\n  排查建议:');
    console.error('    • 确认地址是否正确（/v1 有没有多写或少写都能自动处理）');
    console.error('    • 确认 API Key 是否有效、是否已过期');
    console.error('    • 确认网络能否访问该地址');
    process.exit(1);
  }

  console.log(`\n  ✅ 发现 ${disc.models.length} 个模型（协议: ${disc.protocol}）`);
  for (const m of disc.models.slice(0, 20)) {
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : '-';
    console.log(`     • ${m.id.padEnd(46)} ${ctx.padStart(6)}  ${m.tags.slice(0, 3).join(',')}`);
  }
  if (disc.models.length > 20) console.log(`     … 还有 ${disc.models.length - 20} 个`);

  if (args.list) {
    console.log('\n  (--list 模式，仅列出模型，不修改配置)');
    return;
  }

  // ==================== 3. 选模型 ====================
  let chosen = args.model ?? '';
  const interactive = !args.yes && !args.model && stdin.isTTY;

  if (interactive) {
    header('③ 选择默认模型');
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await rl.question(`  输入模型名（直接回车用 "${disc.models[0]?.id}"）: `)).trim();
      chosen = answer || disc.models[0]?.id || '';
    } finally {
      rl.close();
    }
  } else if (!chosen) {
    chosen = disc.models[0]?.id ?? '';
  }

  if (!chosen) {
    console.error('  ❌ 没有可用模型');
    process.exit(1);
  }
  if (!disc.models.some((m) => m.id === chosen)) {
    console.warn(`  ⚠ 模型 "${chosen}" 不在探测结果里，仍然写入配置。`);
  }

  // ==================== 4. 验证对话 ====================
  header('④ 验证对话');
  console.log(`  正在用 "${chosen}" 发一条测试消息…`);
  const t = await testChat(baseURL, apiKey, chosen, disc.protocol, 30000);

  if (t.ok) {
    console.log(`  ✅ 对话成功（${t.latencyMs}ms）`);
    console.log(`     模型回复: ${(t.reply ?? '').slice(0, 80)}`);
  } else {
    console.log(`  ⚠ 对话测试失败: ${t.error}`);
    console.log('     模型列表可用，但该模型可能不支持对话或需要不同参数。');
    console.log('     你仍可继续，稍后在面板里换一个模型。');
  }

  // ==================== 5. 写入配置 ====================
  header('⑤ 写入配置');
  const cfgDir = path.join(PROJECT_ROOT, 'config');

  // 地址/协议写进 providers.yaml
  const patch: { baseURL?: string; protocol?: string; apiKeyEnv?: string } = {};
  if (args.url) patch.baseURL = args.url;
  if (args.url) {
    writeProvider(cfgDir, providerKey, patch);
    console.log(`  ✅ 已更新 config/providers.yaml（${providerKey} 的 baseURL）`);
  }

  // 密钥优先写 .env（已 gitignore），保持配置文件里只有间接引用
  if (args.key) {
    const varName = prov.apiKeyEnv || 'API_API_KEY';
    writeEnvKey(PROJECT_ROOT, varName, args.key);
    console.log(`  ✅ 密钥已写入 .env（${varName}），未写入 YAML`);
    console.log('     .env 已在 .gitignore 中，不会被提交');
  }

  // 写默认 provider 和 model
  const appYaml = path.join(cfgDir, 'app.yaml');
  let appRaw = fs.readFileSync(appYaml, 'utf8');
  appRaw = appRaw.replace(/(defaultProvider:\s*).*/, `$1${providerKey}`);
  // 替换或插入 defaultModel
  if (/defaultModel:\s*.+/.test(appRaw)) {
    appRaw = appRaw.replace(/(defaultModel:\s*).*/, `$1${chosen}`);
  } else {
    appRaw = appRaw.replace(/(defaultProvider:\s*.*)/, `$1\n  defaultModel: "${chosen}"`);
  }
  fs.writeFileSync(appYaml, appRaw, 'utf8');
  console.log(`  ✅ 已设置默认 provider: ${providerKey}`);
  console.log(`  ✅ 已设置默认 model: ${chosen}`);

  // 缓存模型列表到 providers.cache.json，启动时立即可用
  const cacheFile = path.join(PROJECT_ROOT, 'data', 'providers.cache.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  let cacheObj: { version: number; entries: Record<string, unknown> };
  if (fs.existsSync(cacheFile)) {
    try {
      cacheObj = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { version: number; entries: Record<string, unknown> };
      if (typeof cacheObj !== 'object' || !cacheObj.entries) cacheObj = { version: 1, entries: {} };
    } catch {
      cacheObj = { version: 1, entries: {} };
    }
  } else {
    cacheObj = { version: 1, entries: {} };
  }
  cacheObj.entries[providerKey] = {
    protocol: disc.protocol,
    models: disc.models,
    discoveredAt: Date.now(),
  };
  fs.writeFileSync(cacheFile, JSON.stringify(cacheObj, null, 2), 'utf8');
  console.log(`  ✅ 已缓存 ${disc.models.length} 个模型（data/providers.cache.json）`);

  // ==================== 完成 ====================
  header('✅ 配置完成');
  console.log('  下一步：');
  console.log('    1. 确认 NapCat 已开启 WebSocket 服务端，监听 ' + cfg.app.napcat.url);
  console.log('    2. 双击 start.bat 启动 Agent');
  console.log(`    3. 打开管理面板 http://${cfg.app.server.host}:${cfg.app.server.port}`);
  console.log('    4. 在 QQ 里私聊机器人，或群里 @机器人');
  console.log('');
}

main().catch((e: unknown) => {
  console.error('\n向导执行失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
