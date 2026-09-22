/**
 * 全局类型定义与配置 Schema
 *
 * 所有配置都在此处集中校验，任何配置错误都会在启动时立刻暴露，
 * 而不是等到运行中才炸。
 */
import { z } from 'zod';

// ============================================================
// 配置 Schema
// ============================================================

export const LogSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  pretty: z.boolean().default(true),
});

export const StorageSchema = z.object({
  dbPath: z.string().default('data/brain.db'),
  logDir: z.string().default('logs'),
});

export const NapCatSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['reverse-ws-client', 'ws-server']).default('reverse-ws-client'),
  url: z.string().default('ws://127.0.0.1:3001'),
  accessToken: z.string().default(''),
  selfId: z.number().int().nonnegative().default(0),
  reconnect: z
    .object({
      initialMs: z.number().int().positive().default(1000),
      maxMs: z.number().int().positive().default(30000),
      factor: z.number().positive().default(1.8),
    })
    .prefault({}),
  heartbeat: z
    .object({
      intervalMs: z.number().int().positive().default(30000),
      timeoutMs: z.number().int().positive().default(10000),
    })
    .prefault({}),
});

export const TriggerSchema = z.object({
  private: z.enum(['always', 'keyword', 'prefix']).default('always'),
  privateKeywords: z.array(z.string()).default([]),
  group: z
    .object({
      requireAt: z.boolean().default(true),
      keywords: z.array(z.string()).default([]),
      prefixes: z.array(z.string()).default([]),
      cooldownMs: z.number().int().nonnegative().default(5000),
      maxConcurrent: z.number().int().positive().default(2),
      ignoreSelf: z.boolean().default(true),
      /** 群白名单：非空时只有这些群里的消息才会被处理 */
      enabledGroups: z.array(z.number().int()).default([]),
      /** 记录群内所有人的发言作为上下文 */
      recordAllMessages: z.boolean().default(true),
    })
    .prefault({}),
  /** 用户白名单：非空时只有这些 QQ 能被处理 */
  allowUsers: z.array(z.number().int()).default([]),
  /** 用户黑名单，优先级高于白名单 */
  denyUsers: z.array(z.number().int()).default([]),
  /** 管理员 QQ：可以使用命令、切换人格等 */
  admins: z.array(z.number().int()).default([]),
  /** true = 只有管理员能用全部命令 */
  commandAdminOnly: z.boolean().default(false),
  /** true = 只有管理员能通过命令切换人格（查看不受限） */
  personaAdminOnly: z.boolean().default(false),
});

/**
 * 主动发言。
 *
 * 两条策略，各自有**独立可调的概率**：
 *
 *   ① 话题相关（relevant）
 *      大家在聊的内容跟机器人的记忆/人格对得上 → 适合插话。
 *      相关度 ≥ relevanceThreshold 时用 relevanceProbability 掷骰。
 *
 *   ② 每几句消息（probability）
 *      群里每积累 everyNMessages 条消息就掷一次骰子，用 probability。
 *      基础概率，保证"不管聊什么，聊够了我都可能搭一句"。
 *
 * mode=hybrid 时两者结合：相关就用高概率，不相关就用基础概率。
 *
 * 所有概率都受三道硬闸门约束（不受概率影响）：免打扰时段、最小间隔、每小时上限。
 * 这是刻意的 —— 概率再高也不该刷屏。
 */
export const ProactiveSchema = z.object({
  enabled: z.boolean().default(true),
  /** off 关闭 / probability 只按消息条数 / relevant 只按话题相关 / hybrid 两者结合 */
  mode: z.enum(['off', 'probability', 'relevant', 'hybrid']).default('hybrid'),

  /** 「每几句消息」：每积累这么多条群消息算一个发言机会 */
  everyNMessages: z.number().int().min(1).max(500).default(8),
  /** 基础概率 0~1：到机会点时（且话题不相关）的发言概率 */
  probability: z.number().min(0).max(1).default(0.3),
  /** 话题相关时的发言概率 0~1，通常比基础概率高 */
  relevanceProbability: z.number().min(0).max(1).default(0.7),
  /** 相关度阈值 0~1，越高越挑剔 */
  relevanceThreshold: z.number().min(0).max(1).default(0.6),

  /**
   * 同一会话两次主动发言的最小间隔（毫秒）。0 = 不限制。
   */
  minIntervalMs: z.number().int().nonnegative().default(600000),
  /** 距机器人上次说话（含被动回复）至少隔这么久，避免它刚说完又插嘴。0 = 不限制 */
  minGapAfterBotMs: z.number().int().nonnegative().default(180000),
  /**
   * 每会话每小时上限。**0 = 不限制**。
   *
   * 三个频率闸门（minIntervalMs / minGapAfterBotMs / maxPerHourPerScope）
   * 统一遵循「0 = 不限制」，跟概率类字段（0 = 从不）区分开。
   * 想彻底关掉主动发言请用 enabled: false 或 mode: off，而不是把上限设成 0。
   */
  maxPerHourPerScope: z.number().int().nonnegative().default(3),
  /**
   * 主动搭话时，往回翻多少张**历史图片**一起理解。
   *
   * 为什么需要：主动搭话是"攒够 N 条消息才开口"，那 N 条里别人发的图/表情包
   * 在上下文里只是 `[图片]` / `[表情包]` 这种占位文字，模型看不到画面本身，
   * 于是会答非所问。这里把最近的历史图片按时间顺序附在本轮消息上。
   *
   * 0 = 关闭（不看历史图片，省 token）。
   */
  imageLookback: z.number().int().min(0).max(10).default(3),
  quietHours: z.array(z.string()).default(['23:00-08:00']),
  onlyWhenAddressed: z.boolean().default(false),
});

export const PersonaConfigSchema = z.object({
  default: z.string().default('catgirl'),
  scope: z
    .object({
      private: z.string().default(''),
      groups: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
  commandEnabled: z.boolean().default(true),
  commandPrefix: z.string().default('/persona'),
});

/**
 * 模型用途（角色）。
 *
 * 一个 Agent 会在不同环节调用模型，各自适合的模型并不相同：
 *   chat      主对话       —— 要质量
 *   emotion   情绪分析     —— 高频、短输入，适合便宜的小模型
 *   summary   上下文压缩   —— 长输入，适合上下文大的模型
 *   facts     事实抽取     —— 结构化输出，适合听话的模型
 *   embedding 向量化       —— 语义记忆检索（/embeddings 接口）
 *   vision    图片理解     —— 多模态模型
 *
 * provider / model 留空 = 继承 llm.defaultProvider / llm.defaultModel。
 */
export const LlmRoleSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
});
export type LlmRole = z.infer<typeof LlmRoleSchema>;

export const LlmRolesSchema = z.object({
  chat: LlmRoleSchema.prefault({}),
  emotion: LlmRoleSchema.prefault({}),
  summary: LlmRoleSchema.prefault({}),
  facts: LlmRoleSchema.prefault({}),
  embedding: LlmRoleSchema.prefault({}),
  vision: LlmRoleSchema.prefault({}),
});
export type LlmRoles = z.infer<typeof LlmRolesSchema>;

/** 可配置的用途名列表（面板按此渲染） */
export const LLM_ROLE_NAMES = ['chat', 'emotion', 'summary', 'facts', 'embedding', 'vision'] as const;
export type LlmRoleName = (typeof LLM_ROLE_NAMES)[number];

/** 用途的中文说明，供面板展示 */
export const LLM_ROLE_LABELS: Record<LlmRoleName, { name: string; desc: string; hint: string }> = {
  chat: { name: '主对话', desc: '生成回复', hint: '建议用质量最好的模型' },
  emotion: { name: '情绪分析', desc: '识别用户情绪', hint: '调用频繁，建议用便宜的小模型' },
  summary: { name: '上下文压缩', desc: '把长对话压成摘要', hint: '输入较长，建议用上下文大的模型' },
  facts: { name: '记忆抽取', desc: '抽取长期事实', hint: '需要稳定输出 JSON' },
  embedding: { name: '向量化', desc: '语义记忆检索', hint: '需支持 /embeddings 接口，如 text-embedding-3-small、bge-m3' },
  vision: { name: '图片理解', desc: '理解图片消息', hint: '需多模态模型，如 gpt-4o、claude、gemini' },
};

export const LlmSchema = z.object({
  /** 默认供应商 key（对应 providers.yaml 里的 key） */
  defaultProvider: z.string().default(''),
  /** 默认模型 ID（为空时用该 provider 发现到的第一个模型） */
  defaultModel: z.string().default(''),
  fallback: z.array(z.string()).default([]),
  /** 各用途的模型覆盖；留空继承 default* */
  roles: LlmRolesSchema.prefault({}),
  /**
   * 手工纠正模型能力推断。
   * 推断只能看模型名，中转站常改名（把 deepseek-flash 叫成 deepseek-v4.1-flash 之类），
   * 猜错了就会出现"明明是视觉模型却被当成不能读图"。
   * 例：
   *   modelOverrides:
   *     "deepseek-v4.1-flash": { vision: true }
   *     "some-old-model":      { vision: false }
   */
  modelOverrides: z
    .record(
      z.string(),
      z
        .object({
          vision: z.boolean().optional(),
          contextWindow: z.number().int().positive().optional(),
        })
        .prefault({}),
    )
    .prefault({}),
  request: z
    .object({
      timeoutMs: z.number().int().positive().default(120000),
      maxRetries: z.number().int().nonnegative().default(2),
      retryDelayMs: z.number().int().nonnegative().default(800),
    })
    .prefault({}),
  generation: z
    .object({
      temperature: z.number().min(0).max(2).default(0.8),
      maxTokens: z.number().int().positive().default(1024),
      stream: z.boolean().default(true),
      /**
       * 摘要（上下文压缩）单独用更大的预算。
       * 推理模型会先输出思维链再给正文，预算太小会导致正文为空
       * （表现为"摘要生成结果为空"，压缩静默失效）。
       */
      summaryMaxTokens: z.number().int().positive().default(1200),
    })
    .prefault({}),
});

export const MemorySchema = z.object({
  recentTurns: z.number().int().positive().default(12),
  factExtraction: z.boolean().default(true),
  factExtractionModel: z.string().default(''),
  retrieval: z
    .object({
      fts: z.boolean().default(true),
      limit: z.number().int().positive().default(20),
      timeDecayHalfLifeDays: z.number().positive().default(30),
      /** 语义检索：用 llm.roles.embedding 配置的模型做向量召回（未配置则自动跳过） */
      semantic: z.boolean().default(false),
      /** 语义召回的最低余弦相似度 */
      semanticMinScore: z.number().min(0).max(1).default(0.35),
      /** identity-facts = 只跨群共享身份类事实；full = 全部；none = 不共享 */
      crossScopeSharing: z.enum(['identity-facts', 'full', 'none']).default('identity-facts'),
      shareableFactTypes: z.array(z.string()).default(['identity', 'preference', 'skill', 'goal']),
    })
    .prefault({}),
  summary: z
    .object({
      enabled: z.boolean().default(true),
      triggerMessages: z.number().int().positive().default(40),
      keepRecentTurns: z.number().int().positive().default(8),
      maxLevel: z.number().int().min(1).max(5).default(3),
    })
    .prefault({}),
});

export const EmotionSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['rule', 'llm', 'hybrid']).default('hybrid'),
  model: z.string().default(''),
  smoothing: z.number().min(0).max(1).default(0.3),
  affectPersona: z.boolean().default(true),
  dimensions: z.array(z.enum(['valence', 'arousal', 'dominance'])).default(['valence', 'arousal', 'dominance']),
});

export const ContextSchema = z.object({
  maxTokensRatio: z.number().min(0.1).max(1).default(0.7),
  modelContextWindow: z.number().int().positive().default(32768),
  reserveForReply: z.number().int().nonnegative().default(1024),
  compressStrategy: z.enum(['trim', 'summary', 'layered']).default('layered'),
});

/**
 * 回复行为：让机器人更像真人。
 * 分段发送与延迟算法的思路参考 AstrBot 的 respond stage。
 */
export const ReplyBehaviorSchema = z.object({
  /** 分条发送：把一条回复拆成多条发出，中间停顿 */
  segmented: z
    .object({
      enabled: z.boolean().default(false),
      /** 按字数用对数函数算停顿（更像真人打字），否则用固定区间随机 */
      intervalMethod: z.enum(['log', 'random']).default('log'),
      /** log 方法的底数，越大停顿增长越平缓 */
      logBase: z.number().positive().default(2.3),
      /** random 方法的停顿区间（秒） */
      interval: z.array(z.number().nonnegative()).length(2).default([1.5, 3.5]),
      /** 最多拆成几条，避免刷屏 */
      maxSegments: z.number().int().min(1).max(10).default(4),
      /** 短于这个字数就不拆 */
      minCharsToSplit: z.number().int().nonnegative().default(30),
    })
    .prefault({}),
  /** 群里回复时 @ 对方 */
  mentionOnReply: z.boolean().default(true),
  /** 引用对方那条消息再回复 */
  quoteOnReply: z.boolean().default(false),
  /** 整体回复前的"思考"延迟区间（毫秒），让回复不那么即时 */
  typingDelayMs: z.array(z.number().int().nonnegative()).length(2).default([0, 0]),
  /** 被戳一戳时戳回去 */
  pokeBack: z.boolean().default(true),
  /** 被戳时也说一句话 */
  pokeReply: z.boolean().default(true),
  /** 给消息点表情回应（OneBot set_msg_emoji_like） */
  emojiLike: z
    .object({
      enabled: z.boolean().default(false),
      /** 表情 ID，128077 = 👍 */
      emojiId: z.string().default('128077'),
      /** 只在命中这些情绪时点赞 */
      onEmotions: z.array(z.string()).default(['joy']),
    })
    .prefault({}),
  /**
   * 回复时回看几张历史图片。
   *
   * 场景：对方先发了一张图，紧接着又发一条「@机器人 这啥」——
   * 这条消息本身没带图，只看它的话机器人会答"我看不到图"。
   *
   * 回看范围是**机器人上次说话之后**新出现的图片，所以：
   *   - 刚发完图再来问 → 看得到 ✅
   *   - 已经回过的图不会重复塞（省 token，也避免它反复念叨同一张图）✅
   * 0 = 关闭。
   */
  recentImages: z.number().int().min(0).max(5).default(2),
});
export type ReplyBehavior = z.infer<typeof ReplyBehaviorSchema>;

/**
 * 一张表情包的元数据。
 *
 * 文件名仍然决定初始标签（happy_01.png → happy），但 manifest 里的记录会**覆盖**它：
 * 尤其是「用视觉模型看图后写出来的 desc / useWhen / emotions」——
 * 这是"让 AI 理解表情含义"的落点，也是它能在对的时机挑对图的前提。
 */
export const StickerEntrySchema = z.object({
  /** 相对表情包目录的路径，作为稳定主键（如 qq/ab12cd.png） */
  file: z.string().min(1),
  /** 标签，模型用 `[表情:标签]` 引用 */
  tags: z.array(z.string()).prefault([]),
  /** 一句话描述图里是什么（AI 看图生成或手填） */
  desc: z.string().default(''),
  /** 什么情境下适合发这张（AI 生成或手填） */
  useWhen: z.string().default(''),
  /** 适合的情绪标签，用于纯规则自动补图 */
  emotions: z.array(z.string()).prefault([]),
  /** 来源：本地自己放的 / 从 QQ 收藏导入的 */
  source: z.enum(['local', 'qq']).default('local'),
  /** QQ 收藏表情的原始标识，用于增量导入去重与回写描述 */
  resId: z.string().optional(),
  md5: z.string().optional(),
  emojiId: z.string().optional(),
  /** 导入时的原始 URL（会过期，仅作排查线索） */
  url: z.string().optional(),
  /** 最后一次 AI 识别的时间戳 */
  analyzedAt: z.number().optional(),
  /** AI 识别用的模型，便于判断该不该重跑 */
  analyzedBy: z.string().optional(),
});
export type StickerEntry = z.infer<typeof StickerEntrySchema>;

/** 表情包 manifest 文件结构 */
export const StickerManifestSchema = z.object({
  version: z.number().int().default(1),
  entries: z.array(StickerEntrySchema).prefault([]),
});
export type StickerManifest = z.infer<typeof StickerManifestSchema>;

/**
 * 表情包。
 * 目录里放图片文件，文件名即标签（happy_01.png → happy）。
 */
export const StickerSchema = z.object({
  enabled: z.boolean().default(false),
  /** 表情包目录（相对项目根） */
  dir: z.string().default('config/stickers'),
  /** manifest 文件名（相对表情包目录），存每张图的标签与 AI 理解结果 */
  manifest: z.string().default('manifest.json'),
  /** 一条回复最多发几张，避免刷屏 */
  maxPerReply: z.number().int().min(0).max(3).default(1),
  /** 命中这些情绪时，即使模型没主动发，也随机补一张（旧字段，等价 autoSend.emotions） */
  autoOnEmotions: z.array(z.string()).default([]),
  /** 写进提示词的标签数量上限，防止把上下文撑爆 */
  maxTagsInPrompt: z.number().int().min(1).max(200).default(40),
  /** 提示词里每个标签附带的描述截断长度（0 = 不附描述） */
  descCharsInPrompt: z.number().int().min(0).max(60).default(18),
  /** 纯规则自动补图（不依赖模型主动写标记） */
  autoSend: z
    .object({
      enabled: z.boolean().default(false),
      /** 命中这些情绪时考虑自动发图 */
      emotions: z.array(z.string()).prefault([]),
      /** 情绪强度低于此值不发 */
      minIntensity: z.number().min(0).max(1).default(0.55),
      /** 命中后的实际发送概率，避免每次都发显得机械 */
      probability: z.number().min(0).max(1).default(0.35),
      /** 同一会话两次自动发图的最小间隔（秒），防刷屏 */
      cooldownSec: z.number().int().min(0).default(180),
      /** 只发"被 AI 理解过"（有 desc）的表情包 */
      requireDesc: z.boolean().default(true),
    })
    .prefault({}),
});
export type StickerConfig = z.infer<typeof StickerSchema>;

/** 从 QQ 收藏拉回来的一条表情 */
export const QqFavEmojiSchema = z.object({
  url: z.string().default(''),
  resId: z.string().default(''),
  md5: z.string().default(''),
  emojiId: z.string().default(''),
  desc: z.string().default(''),
});
export type QqFavEmoji = z.infer<typeof QqFavEmojiSchema>;

export const ServerSchema = z.object({  enabled: z.boolean().default(true),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(3081),
  authToken: z.string().default(''),
});

export const AppConfigSchema = z.object({
  app: z
    .object({
      name: z.string().default('qq-agent'),
      timezone: z.string().default('Asia/Shanghai'),
    })
    .prefault({}),
  log: LogSchema.prefault({}),
  storage: StorageSchema.prefault({}),
  napcat: NapCatSchema.prefault({}),
  trigger: TriggerSchema.prefault({}),
  proactive: ProactiveSchema.prefault({}),
  persona: PersonaConfigSchema.prefault({}),
  llm: LlmSchema.prefault({}),
  memory: MemorySchema.prefault({}),
  emotion: EmotionSchema.prefault({}),
  context: ContextSchema.prefault({}),
  reply: ReplyBehaviorSchema.prefault({}),
  sticker: StickerSchema.prefault({}),
  server: ServerSchema.prefault({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// ============================================================
// Provider 配置
// ============================================================

export const ProtocolSchema = z.enum(['openai', 'anthropic', 'gemini', 'ollama', 'auto']);
export type Protocol = z.infer<typeof ProtocolSchema>;

export const ProviderSchema = z.object({
  displayName: z.string().default(''),
  protocol: ProtocolSchema.default('auto'),
  baseURL: z.string(),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().default(''),
  models: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().default(''),
        contextWindow: z.number().int().positive().optional(),
        supportsVision: z.boolean().optional(),
        supportsTools: z.boolean().optional(),
        supportsStream: z.boolean().optional(),
        tags: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  discover: z
    .object({
      mode: z.enum(['auto', 'openai', 'anthropic', 'gemini', 'ollama', 'manual']).default('auto'),
    })
    .prefault({}),
  headers: z.record(z.string(), z.string()).prefault({}),
  enabled: z.boolean().default(true),
});

export const ProvidersFileSchema = z.object({
  providers: z.record(z.string(), ProviderSchema),
});

export type ProviderConfig = z.infer<typeof ProviderSchema>;
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;

// ============================================================
// 人格
// ============================================================

export const PersonaSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().default('🤖'),
  description: z.string().default(''),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  systemPrompt: z.string(),
  /**
   * 预设对话（few-shot 示例）。
   * 会作为真实对话轮次插在 system 之后发给模型 —— 比写在 systemPrompt
   * 文字里更能稳定人格语气与回答风格。只作用于本次请求，不落库。
   */
  examples: z
    .array(z.object({ user: z.string(), assistant: z.string() }))
    .default([]),
  /**
   * 模型调用失败时用这句回复（按人格口吻写）。
   * 留空则用通用的兜底文案。参考 AstrBot 的 custom_error_message。
   */
  errorMessage: z.string().default(''),
  /**
   * 被戳一戳时可能回的话（随机挑一句）。
   * 留空则用通用池。这里刻意不调 LLM —— 戳一戳是高频互动，
   * 每次都调模型既慢又贵，而且真人被戳也不会"思考"半天。
   */
  pokeReplies: z.array(z.string()).default([]),
  /** 按用户情绪调整语气的提示词 */
  emotionModulation: z.record(z.string(), z.string()).prefault({}),
  triggers: z
    .object({
      keywords: z.array(z.string()).default([]),
      command: z.string().default(''),
    })
    .prefault({}),
});

export type Persona = z.infer<typeof PersonaSchema>;

// ============================================================
// OneBot 11 事件与动作
// ============================================================

/** OneBot 11 消息段 */
export interface ObMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface ObSender {
  user_id?: number;
  nickname?: string;
  card?: string;
  role?: 'owner' | 'admin' | 'member';
}

export interface ObEventBase {
  time: number;
  self_id: number;
  post_type: string;
}

export interface ObMessageEvent extends ObEventBase {
  post_type: 'message' | 'message_sent';
  message_type: 'private' | 'group';
  sub_type: string;
  message_id: number;
  user_id: number;
  message: string | ObMessageSegment[];
  raw_message: string;
  font: number;
  sender: ObSender;
  group_id?: number;
  target_id?: number;
}

export interface ObNoticeEvent extends ObEventBase {
  post_type: 'notice';
  notice_type: string;
  [k: string]: unknown;
}

export interface ObMetaEvent extends ObEventBase {
  post_type: 'meta_event';
  meta_event_type: string;
  [k: string]: unknown;
}

export type ObEvent = ObMessageEvent | ObNoticeEvent | ObMetaEvent | (ObEventBase & Record<string, unknown>);

/**
 * 归一化后的「戳一戳」事件。
 * OneBot 用 notice + notice_type=poke 表示（不同实现字段名有差异）。
 */
export interface PokeEvent {
  scope: string;
  scopeType: 'private' | 'group';
  groupId?: number;
  /** 发起戳的人 */
  userId: number;
  /** 被戳的人 */
  targetId: number;
  selfId: number;
  senderName: string;
  timestamp: number;
}

/** 归一化后的入站消息 */
export interface InboundMessage {
  /** 会话唯一键：private:123 或 group:456 */
  scope: string;
  scopeType: 'private' | 'group';
  /** 发送者 QQ —— 唯一身份 ID */
  userId: number;
  /** 群号（私聊为 undefined） */
  groupId?: number;
  messageId: number;
  selfId: number;
  /** 纯文本（已剥离 CQ 码/消息段，含 @ 占位） */
  text: string;
  /** 原始消息段 */
  segments: ObMessageSegment[];
  /** 是否 @ 了机器人 */
  mentionsBot: boolean;
  senderName: string;
  role?: 'owner' | 'admin' | 'member';
  timestamp: number;
  raw: ObMessageEvent;
}

export interface OneBotResponse<T = unknown> {
  status: 'ok' | 'failed' | 'async';
  retcode: number;
  data: T;
  echo?: string;
  wording?: string;
  msg?: string;
}

// ============================================================
// 情绪
// ============================================================

export interface EmotionScore {
  /** 情绪标签：joy/sadness/anger/anxiety/neutral 等 */
  label: string;
  /** 置信度 0~1 */
  confidence: number;
  /** 效价 -1~1（负到正） */
  valence: number;
  /** 唤醒度 0~1（平静到激动） */
  arousal: number;
  /** 支配度 0~1（无力到掌控） */
  dominance: number;
  /** 强度 0~1 */
  intensity: number;
}

// ============================================================
// 对话消息（内部统一格式）
// ============================================================

/**
 * 多模态内容片段。
 * 图片统一用 base64 承载（不含 `data:` 前缀），由各协议适配器转成
 * 自己需要的形状 —— 这样上层不用关心协议差异。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** 纯文本，或带图片的多模态片段数组 */
  content: string | ContentPart[];
  name?: string;
}

/** 把消息内容取成纯文本（图片表示为占位符），用于估算 token 与日志 */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((p) => (p.type === 'text' ? p.text : '[图片]'))
    .join('');
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResult {
  content: string;
  model: string;
  provider: string;
  usage: LlmUsage;
  finishReason?: string;
  latencyMs: number;
  /**
   * 推理模型的思维链（reasoning_content）。
   * 只用于诊断——例如 content 为空时判断是不是推理把 token 预算吃光了。
   * 不会发给用户，也不会进入上下文。
   */
  reasoning?: string;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsStream?: boolean;
  tags: string[];
}

export interface DiscoverResult {
  ok: boolean;
  /** 实际生效的协议（auto 会被解析为具体协议） */
  protocol: Exclude<Protocol, 'auto'>;
  models: DiscoveredModel[];
  /** 探测过程记录，用于面板展示"为什么失败" */
  attempts: Array<{ url: string; protocol: string; status: number | null; ok: boolean; note: string }>;
  error?: string;
}
