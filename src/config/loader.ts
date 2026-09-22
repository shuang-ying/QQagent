/**
 * 配置加载器
 *
 * 职责：
 *  1. 从 config/ 读取 app.yaml、providers.yaml、personas/*.yaml
 *  2. 用 zod 严格校验，错误信息友好可读
 *  3. 解析 API Key：进程环境变量 -> .env -> DSH 凭据库 -> 配置文件明文
 *  4. 支持 local 覆盖文件（*.local.yaml），便于本机私密配置
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  AppConfigSchema,
  ProvidersFileSchema,
  PersonaSchema,
  type AppConfig,
  type ProviderConfig,
  type Persona,
} from '../core/types.js';

/**
 * 定位项目根目录。
 *
 * 不能简单用「模块路径上两级」：那样在 dist/ 下运行时
 * （dist/src/config/loader.js -> dist/）会找不到 config/app.yaml。
 * 改为从模块所在目录逐级向上查找含 config/app.yaml 的目录，
 * 这样 tsx 直跑源码和 node 跑编译产物都能正确定位。
 */
function findProjectRoot(): string {
  const explicit = process.env.QQ_AGENT_ROOT;
  if (explicit && fs.existsSync(path.join(explicit, 'config', 'app.yaml'))) {
    return path.resolve(explicit);
  }

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'config', 'app.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** 项目根目录（自动向上查找） */
export const PROJECT_ROOT = findProjectRoot();

export class ConfigError extends Error {
  constructor(message: string, public readonly file?: string) {
    super(file ? `[配置错误] ${file}\n${message}` : `[配置错误] ${message}`);
    this.name = 'ConfigError';
  }
}

function readYamlFile(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return parseYaml(raw);
  } catch (e) {
    throw new ConfigError(`YAML 语法错误：${(e as Error).message}`, file);
  }
}

/** 深度合并：后者覆盖前者，对象递归合并，数组整体替换 */
function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override as T;
  if (typeof base !== 'object' || typeof override !== 'object') return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function formatZodError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues;
  if (!issues) return String(err);
  return issues.map((i) => `  • ${i.path.join('.') || '(根)'}: ${i.message}`).join('\n');
}

/** 加载 .env（极简实现，避免额外依赖） */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const key = m[1]!;
    let val = m[2] ?? '';
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * 从 DSH 凭据库读取密钥。
 * 方便：用户已在 DSH 里配好的 API key 无需重复填写。
 * 结构：{ version: 1, records: {...}, refs: { API_API_KEY: "sk-..." } }
 */
function readDshCredential(name: string): string | undefined {
  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    process.env.DSH_HOME ? path.join(process.env.DSH_HOME, '.credentials.yaml') : '',
  ].filter(Boolean);

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const doc = readYamlFile(file) as { refs?: Record<string, string> } | undefined;
      const val = doc?.refs?.[name];
      if (typeof val === 'string' && val.trim()) return val.trim();
    } catch {
      // 凭据文件不可读时静默跳过，不影响主流程
    }
  }
  return undefined;
}

/** 解析 provider 的实际密钥 */
export function resolveApiKey(p: ProviderConfig): string {
  const looksLikeRef = (v: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);

  // 1. 显式 apiKey（若它其实是个环境变量名，也尝试解析）
  if (p.apiKey) {
    if (looksLikeRef(p.apiKey) && process.env[p.apiKey]) return process.env[p.apiKey]!;
    if (looksLikeRef(p.apiKey)) {
      const dsh = readDshCredential(p.apiKey);
      if (dsh) return dsh;
    }
    return p.apiKey;
  }
  // 2. apiKeyEnv 指定的环境变量
  if (p.apiKeyEnv) {
    if (process.env[p.apiKeyEnv]) return process.env[p.apiKeyEnv]!;
    const dsh = readDshCredential(p.apiKeyEnv);
    if (dsh) return dsh;
  }
  return '';
}

export interface LoadedConfig {
  app: AppConfig;
  providers: Record<string, ProviderConfig>;
  personas: Persona[];
  root: string;
}

/**
 * 就地归一化老配置（在 zod 校验前调用）。
 *
 * 目前只处理 proactive.mode：取值集合从
 *   off | random | relevant | mention-only-when-relevant
 * 改成了
 *   off | probability | relevant | hybrid
 * 老值直接喂给枚举会校验失败，所以在这里映射一次。
 */
export function migrateLegacyAppConfig(app: unknown): void {
  if (!app || typeof app !== 'object') return;
  const p = (app as Record<string, unknown>)['proactive'];
  if (!p || typeof p !== 'object') return;
  const pro = p as Record<string, unknown>;
  const mode = pro['mode'];
  if (mode === 'random' || mode === 'random-when-quiet') {
    pro['mode'] = 'probability';
  } else if (mode === 'mention-only-when-relevant') {
    // 老名字强调"仅在被提及时"，但实际语义就是按话题相关插话；
    // "仅在被提及时"的语义由 onlyWhenAddressed 字段自己管。
    pro['mode'] = 'relevant';
  }
}

export function loadConfig(root = PROJECT_ROOT): LoadedConfig {
  const cfgDir = path.join(root, 'config');

  loadDotEnv(path.join(root, '.env'));

  // ---------- app.yaml ----------
  const appBase = readYamlFile(path.join(cfgDir, 'app.yaml'));
  if (appBase === undefined) {
    throw new ConfigError(`未找到 config/app.yaml`, path.join(cfgDir, 'app.yaml'));
  }
  const appLocal = readYamlFile(path.join(cfgDir, 'app.local.yaml'));
  const appMerged = deepMerge(appBase, appLocal);

  // 旧字段迁移必须在 safeParse **之前**做：proactive.mode 的取值集合变过，
  // 老值（random / mention-only-when-relevant）会让枚举校验直接失败、
  // 整个程序起不来。所以先归一化，再校验。
  migrateLegacyAppConfig(appMerged);

  const appParsed = AppConfigSchema.safeParse(appMerged);
  if (!appParsed.success) {
    throw new ConfigError(formatZodError(appParsed.error), path.join(cfgDir, 'app.yaml'));
  }
  const app = appParsed.data;

  // 早期版本把「情绪模型 / 抽取模型」放在 emotion.model 和
  // memory.factExtractionModel 里，现在统一由 llm.roles 管理。
  // 这里做一次单向迁移，避免老配置被静默忽略。
  if (!app.llm.roles.emotion.model && app.emotion.model) {
    app.llm.roles.emotion.model = app.emotion.model;
  }
  if (!app.llm.roles.facts.model && app.memory.factExtractionModel) {
    app.llm.roles.facts.model = app.memory.factExtractionModel;
  }

  // ---------- providers.yaml ----------
  const provBase = readYamlFile(path.join(cfgDir, 'providers.yaml')) ?? { providers: {} };
  const provLocal = readYamlFile(path.join(cfgDir, 'providers.local.yaml'));
  const provMerged = deepMerge(provBase, provLocal);
  const provParsed = ProvidersFileSchema.safeParse(provMerged);
  if (!provParsed.success) {
    throw new ConfigError(formatZodError(provParsed.error), path.join(cfgDir, 'providers.yaml'));
  }
  const providers = provParsed.data.providers;

  // 默认 provider 校验：
  //   - defaultProvider 非空但 provider 不存在 -> 报错（用户配错了）
  //   - defaultProvider 为空 -> 不报错，允许无 provider 启动（用户可在面板里添加）
  if (app.llm.defaultProvider && !providers[app.llm.defaultProvider]) {
    const names = Object.keys(providers);
    throw new ConfigError(
      `llm.defaultProvider = "${app.llm.defaultProvider}" 不存在。\n  已配置的 provider: ${names.length ? names.join(', ') : '(无)'}`,
      path.join(cfgDir, 'app.yaml'),
    );
  }
  // defaultProvider 为空时，若已有 provider，自动选第一个为默认
  if (!app.llm.defaultProvider && Object.keys(providers).length > 0) {
    app.llm.defaultProvider = Object.keys(providers)[0]!;
  }

  // ---------- personas/*.yaml ----------
  const personaDir = path.join(cfgDir, 'personas');
  const personas: Persona[] = [];
  if (fs.existsSync(personaDir)) {
    for (const f of fs.readdirSync(personaDir).filter((x) => /\.ya?ml$/.test(x) && !x.includes('.local.'))) {
      const full = path.join(personaDir, f);
      const doc = readYamlFile(full);
      const parsed = PersonaSchema.safeParse(doc);
      if (!parsed.success) {
        throw new ConfigError(formatZodError(parsed.error), full);
      }
      // 文件名与人格 id 不一致时给出提示
      const expected = f.replace(/\.ya?ml$/, '');
      if (parsed.data.id !== expected) {
        // 不阻断启动，仅记录（logger 尚未初始化，用 console）
        console.warn(`  ⚠ 人格文件 ${f} 的 id="${parsed.data.id}" 与文件名不一致，建议统一。`);
      }
      personas.push(parsed.data);
    }
  }
  if (personas.length === 0) {
    throw new ConfigError(`config/personas/ 下未找到任何人格定义`, personaDir);
  }

  // id 唯一性校验
  const seen = new Set<string>();
  for (const p of personas) {
    if (seen.has(p.id)) throw new ConfigError(`人格 id 重复：${p.id}`, personaDir);
    seen.add(p.id);
  }

  return { app, providers, personas, root };
}

/** 把 baseURL 归一化：去掉尾部斜杠与已知的端点后缀 */
export function normalizeBaseUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '');
  // 用户可能直接粘贴完整端点，剥掉它们
  u = u.replace(/\/chat\/completions$/i, '');
  u = u.replace(/\/completions$/i, '');
  u = u.replace(/\/messages$/i, '');
  u = u.replace(/\/models$/i, '');
  return u.replace(/\/+$/, '');
}
