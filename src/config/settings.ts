/**
 * 运行时设置（功能开关 / 模型用途）
 *
 * 面板上的每个开关都对应 app.yaml 里的一个路径。写回流程：
 *   1. 在 cfg 的深拷贝上套用改动
 *   2. 用 AppConfigSchema 校验（防止写出非法配置）
 *   3. 通过 writer 手术式写回 app.yaml（保留注释）
 *   4. 把值原地写回运行时 cfg 对象
 *
 * 第 4 步用「原地赋值」而非替换对象，因为各模块（emotion / trigger /
 * proactive / pipeline）在构造时持有的是子对象的引用，替换会让它们看不到变化。
 */
import type { AppConfig } from '../core/types.js';
import { AppConfigSchema, PersonaSchema, LLM_ROLE_NAMES } from '../core/types.js';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDef {
  /** 点分路径，如 emotion.enabled */
  path: string;
  label: string;
  desc: string;
  type: 'boolean' | 'enum' | 'number' | 'string[]';
  options?: SettingOption[];
  /** number 类型的建议范围（仅用于面板提示，不阻断保存） */
  min?: number;
  max?: number;
  group: string;
}

/** 允许面板修改的配置项白名单（同时也是 UI 的渲染清单） */
export const SETTING_DEFS: SettingDef[] = [
  {
    path: 'trigger.group.requireAt',
    label: '群聊必须 @机器人才回复',
    desc: '关闭后机器人会按关键词/主动策略接话',
    type: 'boolean',
    group: '对话',
  },
  {
    path: 'trigger.group.recordAllMessages',
    label: '记录群内所有人的发言',
    desc: '让机器人理解群聊上下文；记忆仍只归属发言者本人',
    type: 'boolean',
    group: '对话',
  },
  {
    path: 'persona.commandEnabled',
    label: '允许用命令切换人格',
    desc: '用户可在 QQ 里发送 /persona <id>',
    type: 'boolean',
    group: '对话',
  },
  {
    path: 'context.compressStrategy',
    label: '上下文压缩策略',
    desc: 'trim 只裁剪 / summary 摘要 / layered 分层递归摘要',
    type: 'enum',
    options: [
      { value: 'trim', label: '仅裁剪（最省 token）' },
      { value: 'summary', label: '摘要压缩' },
      { value: 'layered', label: '分层摘要（推荐）' },
    ],
    group: '对话',
  },
  {
    path: 'emotion.enabled',
    label: '情绪提取',
    desc: '分析用户情绪，并据此调整人格语气',
    type: 'boolean',
    group: '情绪',
  },
  {
    path: 'emotion.mode',
    label: '情绪提取方式',
    desc: 'rule 零成本 / llm 更准 / hybrid 规则不确定时才调模型',
    type: 'enum',
    options: [
      { value: 'rule', label: '规则（零成本）' },
      { value: 'llm', label: '大模型' },
      { value: 'hybrid', label: '混合（推荐）' },
    ],
    group: '情绪',
  },
  {
    path: 'memory.factExtraction',
    label: '自动抽取长期记忆',
    desc: '从对话中提取喜好、身份等事实存入记忆库',
    type: 'boolean',
    group: '记忆',
  },
  {
    path: 'memory.summary.enabled',
    label: '长对话自动摘要',
    desc: '消息过多时把旧对话压成摘要，避免撑爆上下文',
    type: 'boolean',
    group: '记忆',
  },
  {
    path: 'memory.retrieval.semantic',
    label: '语义检索记忆',
    desc: '用「模型用途 → 向量化」配置的模型做相似度召回；未配置则自动退回关键词检索',
    type: 'boolean',
    group: '记忆',
  },
  {
    path: 'proactive.enabled',
    label: '允许主动发言',
    desc: '机器人在没有 @ 的情况下也可能接话（受频率与免打扰限制）',
    type: 'boolean',
    group: '主动发言',
  },
  {
    path: 'proactive.mode',
    label: '主动发言策略',
    desc: 'probability 每几句消息按概率 / relevant 话题相关时按概率 / hybrid 两者结合（推荐）',
    type: 'enum',
    options: [
      { value: 'off', label: '关闭' },
      { value: 'hybrid', label: '话题相关 + 每几句消息（推荐）' },
      { value: 'relevant', label: '只看话题相关' },
      { value: 'probability', label: '只看每几句消息' },
    ],
    group: '主动发言',
  },
  {
    path: 'proactive.everyNMessages',
    label: '每几句消息评估一次',
    desc: '群里每积累这么多条消息算一个发言机会点（到点才掷概率，不是每条都掷）',
    type: 'number',
    min: 1,
    max: 500,
    group: '主动发言',
  },
  {
    path: 'proactive.probability',
    label: '基础发言概率',
    desc: '0~1。到机会点且话题不相关时的发言概率',
    type: 'number',
    min: 0,
    max: 1,
    group: '主动发言',
  },
  {
    path: 'proactive.relevanceProbability',
    label: '话题相关时的发言概率',
    desc: '0~1。话题跟机器人记忆/人格对得上时用这个概率，通常设得比基础概率高',
    type: 'number',
    min: 0,
    max: 1,
    group: '主动发言',
  },
  {
    path: 'proactive.relevanceThreshold',
    label: '话题相关度阈值',
    desc: '0~1，越高越挑剔。低于它就走基础概率那条路',
    type: 'number',
    min: 0,
    max: 1,
    group: '主动发言',
  },
  {
    path: 'proactive.minIntervalMs',
    label: '两次主动发言最小间隔（毫秒）',
    desc: '硬限制，与概率无关。默认 600000 = 10 分钟；0 = 不限制',
    type: 'number',
    min: 0,
    group: '主动发言',
  },
  {
    path: 'proactive.minGapAfterBotMs',
    label: '距机器人上次说话的最小间隔（毫秒）',
    desc: '避免它刚回复完又立刻插嘴。默认 180000 = 3 分钟；0 = 不限制',
    type: 'number',
    min: 0,
    group: '主动发言',
  },
  {
    path: 'proactive.maxPerHourPerScope',
    label: '每会话每小时上限',
    desc: '硬限制，与概率无关。0 = 不限制（想彻底关掉主动发言请用上面的开关，而不是设 0）',
    type: 'number',
    min: 0,
    max: 1000,
    group: '主动发言',
  },
  {
    path: 'proactive.imageLookback',
    label: '主动搭话时回看几张历史图片',
    desc: '攒够消息开口时，把最近这几张别人发的图/表情包一起理解（0=不看图，省 token）',
    type: 'number',
    min: 0,
    max: 10,
    group: '主动发言',
  },
  {
    path: 'proactive.quietHours',
    label: '免打扰时段',
    desc: '如 ["23:00-08:00"]，这些时段绝不主动发言',
    type: 'string[]',
    group: '主动发言',
  },
  {
    path: 'proactive.onlyWhenAddressed',
    label: '仅在被人叫到时才可能接话',
    desc: '打开后没人 @机器人 就完全不主动发言',
    type: 'boolean',
    group: '主动发言',
  },
  {
    path: 'reply.segmented.enabled',
    label: '分条发送（更像真人）',
    desc: '把长回复拆成几条发出，中间有"打字"停顿；开启后可能显得话多',
    type: 'boolean',
    group: '回复行为',
  },
  {
    path: 'reply.segmented.intervalMethod',
    label: '停顿计算方式',
    desc: 'log = 按字数算（字越多等越久，更像打字）| random = 固定区间随机',
    type: 'enum',
    options: [
      { value: 'log', label: '按字数（推荐）' },
      { value: 'random', label: '固定区间随机' },
    ],
    group: '回复行为',
  },
  {
    path: 'reply.mentionOnReply',
    label: '群里回复时 @ 对方',
    desc: '让被回复的人收到提醒，群聊里更像正常对话',
    type: 'boolean',
    group: '回复行为',
  },
  {
    path: 'reply.quoteOnReply',
    label: '引用对方消息再回复',
    desc: '上下文更清晰，但每条都会带引用框，比较占屏',
    type: 'boolean',
    group: '回复行为',
  },
  {
    path: 'reply.pokeBack',
    label: '被戳一戳就戳回去',
    desc: '收到戳一戳时回戳对方',
    type: 'boolean',
    group: '回复行为',
  },
  {
    path: 'reply.pokeReply',
    label: '被戳时也说一句',
    desc: '回戳的同时发一句话；文案可在人格里用 pokeReplies 自定义',
    type: 'boolean',
    group: '回复行为',
  },
  {
    path: 'reply.emojiLike.enabled',
    label: '给消息点表情回应',
    desc: '对方情绪不错时给那条消息贴个 👍（部分实现不支持）',
    type: 'boolean',
    group: '回复行为',
  },
  {
    path: 'reply.recentImages',
    label: '回复时回看几张历史图片',
    desc: '当前消息没带图时，把「机器人上次说话之后」新发的图一起理解（对方先发图再问"这啥"时很有用）。0=关闭',
    type: 'number',
    min: 0,
    max: 5,
    group: '回复行为',
  },
  {
    path: 'sticker.enabled',
    label: '发表情包',
    desc: '模型可在回复末尾用 [表情:标签] 发一张图；把图片放进 config/stickers，文件名就是标签',
    type: 'boolean',
    group: '回复行为',
  },
  {
    path: 'sticker.autoSend.enabled',
    label: '按情绪自动补图',
    desc: '模型没主动发时，命中情绪且强度足够就自己补一张表情包（受冷却与概率限制）',
    type: 'boolean',
    group: '回复行为',
  },
  {
    path: 'sticker.autoSend.emotions',
    label: '自动补图的情绪',
    desc: '命中这些情绪才自动发图，如 ["sadness", "joy"]',
    type: 'string[]',
    group: '回复行为',
  },
  {
    path: 'sticker.autoSend.minIntensity',
    label: '自动补图的最低情绪强度',
    desc: '0~1，情绪太弱不配图，建议 0.5~0.7',
    type: 'number',
    min: 0,
    max: 1,
    group: '回复行为',
  },
  {
    path: 'sticker.autoSend.probability',
    label: '自动补图概率',
    desc: '0~1，命中后实际发送的概率，避免每次都发显得机械',
    type: 'number',
    min: 0,
    max: 1,
    group: '回复行为',
  },
  {
    path: 'sticker.autoSend.cooldownSec',
    label: '表情包冷却（秒）',
    desc: '同一会话两次自动发图的最小间隔，防刷屏',
    type: 'number',
    min: 0,
    max: 86400,
    group: '回复行为',
  },
  {
    path: 'sticker.autoSend.requireDesc',
    label: '只发 AI 理解过的表情包',
    desc: '开启后只发被视觉模型识别过（有描述）的图，避免发出意义不明的图',
    type: 'boolean',
    group: '回复行为',
  },
];

const ALLOWED = new Set(SETTING_DEFS.map((d) => d.path));

/** 「模型用途」路径：llm.roles.<role>.provider / .model */
function matchRolePath(path: string): { role: string; field: string } | null {
  const m = /^llm\.roles\.([a-z]+)\.(provider|model)$/.exec(path);
  if (!m) return null;
  if (!(LLM_ROLE_NAMES as readonly string[]).includes(m[1]!)) return null;
  return { role: m[1]!, field: m[2]! };
}

function isAllowedPath(path: string): boolean {
  return ALLOWED.has(path) || matchRolePath(path) !== null;
}

/** 读路径值 */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** 原地写路径值（中间缺失则补出对象） */
export function assignPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    const next = cur[k];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  /** 通过校验的 [路径数组, 值] 列表，供持久化使用 */
  entries: Array<[string[], unknown]>;
}

/**
 * 校验一组设置改动。
 * 只在深拷贝上套用并走 zod 校验，通过后返回可持久化的条目。
 */
export function validateSettings(
  cfg: AppConfig,
  patch: Record<string, unknown>,
  /** 已配置的供应商 key 集合，用于校验「模型用途」里的 provider（providers 不在 AppConfig 里） */
  providerKeys: string[] = [],
): ApplyResult {
  const entries: Array<[string[], unknown]> = [];

  for (const [path, value] of Object.entries(patch)) {
    if (!isAllowedPath(path)) {
      return { ok: false, error: `不允许修改的配置项：${path}`, entries: [] };
    }

    // ---- 模型用途：只校验是字符串，并检查 provider 确实存在 ----
    const rolePath = matchRolePath(path);
    if (rolePath) {
      if (typeof value !== 'string') {
        return { ok: false, error: `${path} 必须是字符串`, entries: [] };
      }
      if (rolePath.field === 'provider' && value.trim() && !providerKeys.includes(value.trim())) {
        return { ok: false, error: `供应商 ${value} 不存在`, entries: [] };
      }
      const current = readPath(cfg, path);
      if (value === current) continue;
      entries.push([path.split('.'), value.trim()]);
      continue;
    }

    const def = SETTING_DEFS.find((d) => d.path === path)!;
    const current = readPath(cfg, path);

    if (def.type === 'boolean') {
      if (typeof value !== 'boolean') {
        return { ok: false, error: `${def.label} 需要是布尔值`, entries: [] };
      }
    } else if (def.type === 'enum') {
      const allowed = (def.options ?? []).map((o) => o.value);
      if (typeof value !== 'string' || !allowed.includes(value)) {
        return { ok: false, error: `${def.label} 只能是：${allowed.join(' / ')}`, entries: [] };
      }
    } else if (def.type === 'number') {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        return { ok: false, error: `${def.label} 需要是数字`, entries: [] };
      }
      // 范围交给 zod 兜底，这里只做友好提示级别的校验
      if (def.min !== undefined && n < def.min) {
        return { ok: false, error: `${def.label} 不能小于 ${def.min}`, entries: [] };
      }
      if (def.max !== undefined && n > def.max) {
        return { ok: false, error: `${def.label} 不能大于 ${def.max}`, entries: [] };
      }
      if (n === current) continue;
      entries.push([path.split('.'), n]);
      continue;
    } else if (def.type === 'string[]') {
      const arr = Array.isArray(value)
        ? value.map((v) => String(v).trim()).filter(Boolean)
        : typeof value === 'string'
          ? value.split(/[,，\s]+/).map((v) => v.trim()).filter(Boolean)
          : null;
      if (!arr) return { ok: false, error: `${def.label} 需要是数组或逗号分隔的字符串`, entries: [] };
      if (JSON.stringify(arr) === JSON.stringify(current)) continue;
      entries.push([path.split('.'), arr]);
      continue;
    }

    if (value === current) continue; // 无变化，跳过
    entries.push([path.split('.'), value]);
  }

  if (entries.length === 0) return { ok: true, entries: [] };

  // 在深拷贝上试套用并校验，确保不会写出让下次启动失败的配置
  const probe = structuredClone(cfg) as unknown as Record<string, unknown>;
  for (const [pathArr, value] of entries) {
    assignPath(probe, pathArr.join('.'), value);
  }
  const parsed = AppConfigSchema.safeParse(probe);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: `配置校验失败：${msg}`, entries: [] };
  }

  return { ok: true, entries };
}

// ============================================================
// 访问控制（用户/群白名单、黑名单、管理员）
// ============================================================

/** 可编辑的 QQ 号列表字段 */
export const ACCESS_LIST_PATHS = {
  allowUsers: 'trigger.allowUsers',
  denyUsers: 'trigger.denyUsers',
  allowGroups: 'trigger.group.enabledGroups',
  admins: 'trigger.admins',
} as const;
export type AccessListName = keyof typeof ACCESS_LIST_PATHS;

export const ACCESS_LIST_LABELS: Record<AccessListName, { name: string; desc: string }> = {
  allowUsers: { name: '用户白名单', desc: '非空时，只有名单内的 QQ 能被处理（私聊和群聊都算）' },
  denyUsers: { name: '用户黑名单', desc: '这些 QQ 一律忽略，优先级高于白名单' },
  allowGroups: { name: '群白名单', desc: '非空时，只处理这些群里的消息；私聊不受影响' },
  admins: { name: '管理员 QQ', desc: '可以使用管理类命令（切换人格等）' },
};

/** 可编辑的开关 */
export const ACCESS_FLAG_PATHS = {
  commandAdminOnly: 'trigger.commandAdminOnly',
  personaAdminOnly: 'trigger.personaAdminOnly',
} as const;
export type AccessFlagName = keyof typeof ACCESS_FLAG_PATHS;

export const ACCESS_FLAG_LABELS: Record<AccessFlagName, { name: string; desc: string }> = {
  commandAdminOnly: { name: '命令仅限管理员', desc: '关闭后所有人都能用 /help、/memory、/forget 等' },
  personaAdminOnly: { name: '仅管理员可切换人格', desc: '关闭后群里任何人都能发 /persona 改本群人格' },
};

export interface AccessSnapshot {
  lists: Record<AccessListName, number[]>;
  flags: Record<AccessFlagName, boolean>;
}

/** 读取当前访问控制配置 */
export function readAccess(cfg: AppConfig): AccessSnapshot {
  return {
    lists: {
      allowUsers: [...cfg.trigger.allowUsers],
      denyUsers: [...cfg.trigger.denyUsers],
      allowGroups: [...cfg.trigger.group.enabledGroups],
      admins: [...cfg.trigger.admins],
    },
    flags: {
      commandAdminOnly: cfg.trigger.commandAdminOnly,
      personaAdminOnly: cfg.trigger.personaAdminOnly,
    },
  };
}

/** 把面板传来的 QQ 列表规整成去重、升序的整数数组 */
export function normalizeQqList(input: unknown): { ok: true; value: number[] } | { ok: false; error: string } {
  const arr = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[\s,，、;；]+/).filter(Boolean)
      : null;
  if (arr === null) return { ok: false, error: 'QQ 号列表格式不正确' };

  const out = new Set<number>();
  for (const raw of arr) {
    const s = String(raw).trim();
    if (!s) continue;
    if (!/^\d{4,12}$/.test(s)) {
      return { ok: false, error: `「${s}」不是合法的 QQ 号（应为 4~12 位数字）` };
    }
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) {
      return { ok: false, error: `「${s}」不是合法的 QQ 号` };
    }
    out.add(n);
  }
  if (out.size > 500) return { ok: false, error: '名单最多 500 个，请精简' };
  return { ok: true, value: [...out].sort((a, b) => a - b) };
}

export interface AccessUpdate {
  lists?: Partial<Record<AccessListName, unknown>>;
  flags?: Partial<Record<AccessFlagName, unknown>>;
}

/**
 * 校验访问控制改动。
 * 除类型外还做一致性检查，避免把机器人配成"谁都管不了"的状态。
 */
export function validateAccess(
  cfg: AppConfig,
  update: AccessUpdate,
): { ok: true; entries: Array<[string[], unknown]> } | { ok: false; error: string } {
  const entries: Array<[string[], unknown]> = [];

  // ---- 列表 ----
  const next: Record<AccessListName, number[]> = {
    allowUsers: cfg.trigger.allowUsers,
    denyUsers: cfg.trigger.denyUsers,
    allowGroups: cfg.trigger.group.enabledGroups,
    admins: cfg.trigger.admins,
  };
  for (const [name, raw] of Object.entries(update.lists ?? {}) as Array<[AccessListName, unknown]>) {
    const path = ACCESS_LIST_PATHS[name];
    if (!path) return { ok: false, error: `未知名单：${name}` };
    const norm = normalizeQqList(raw);
    if (!norm.ok) return { ok: false, error: norm.error };
    next[name] = norm.value;
  }

  // ---- 开关 ----
  const nextFlags: Record<AccessFlagName, boolean> = {
    commandAdminOnly: cfg.trigger.commandAdminOnly,
    personaAdminOnly: cfg.trigger.personaAdminOnly,
  };
  for (const [name, raw] of Object.entries(update.flags ?? {}) as Array<[AccessFlagName, unknown]>) {
    const path = ACCESS_FLAG_PATHS[name];
    if (!path) return { ok: false, error: `未知开关：${name}` };
    if (typeof raw !== 'boolean') return { ok: false, error: `${name} 需要是布尔值` };
    nextFlags[name] = raw;
  }

  // ---- 一致性检查：别把自己锁在外面 ----
  if ((nextFlags.commandAdminOnly || nextFlags.personaAdminOnly) && next.admins.length === 0) {
    return {
      ok: false,
      error: '开启「仅管理员」前，请先在管理员 QQ 里至少填一个号，否则没人能用这些命令（包括你）',
    };
  }
  // 管理员在黑名单里 → 自相矛盾
  const conflicting = next.admins.filter((a) => next.denyUsers.includes(a));
  if (conflicting.length > 0) {
    return { ok: false, error: `管理员 ${conflicting.join(', ')} 同时在黑名单里，请先移除` };
  }
  // 白名单非空但把管理员排除在外
  if (next.allowUsers.length > 0) {
    const excluded = next.admins.filter((a) => !next.allowUsers.includes(a));
    if (excluded.length > 0) {
      return {
        ok: false,
        error: `管理员 ${excluded.join(', ')} 不在用户白名单里，将无法使用机器人，请一并加入白名单`,
      };
    }
  }

  // ---- 生成条目（只记录有变化的） ----
  const currentLists: Record<AccessListName, number[]> = {
    allowUsers: cfg.trigger.allowUsers,
    denyUsers: cfg.trigger.denyUsers,
    allowGroups: cfg.trigger.group.enabledGroups,
    admins: cfg.trigger.admins,
  };
  for (const name of Object.keys(ACCESS_LIST_PATHS) as AccessListName[]) {
    if (JSON.stringify(currentLists[name]) !== JSON.stringify(next[name])) {
      entries.push([ACCESS_LIST_PATHS[name].split('.'), next[name]]);
    }
  }
  for (const name of Object.keys(ACCESS_FLAG_PATHS) as AccessFlagName[]) {
    if (cfg.trigger[name] !== nextFlags[name]) {
      entries.push([ACCESS_FLAG_PATHS[name].split('.'), nextFlags[name]]);
    }
  }

  return { ok: true, entries };
}

/** 校验单个人格（面板新增/编辑用） */export function validatePersona(input: unknown): { ok: true; persona: import('../core/types.js').Persona } | { ok: false; error: string } {
  const parsed = PersonaSchema.safeParse(input);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('; ');
    return { ok: false, error: `人格内容不合法：${msg}` };
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(parsed.data.id)) {
    return { ok: false, error: '人格 id 只能用小写字母、数字、下划线和短横线，且不超过 32 个字符' };
  }
  return { ok: true, persona: parsed.data };
}
