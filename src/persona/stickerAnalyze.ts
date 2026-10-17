/**
 * 让 AI「看懂」表情包
 *
 * 文件名只能给出 happy / sad 这种粗标签，但"这张图到底画了什么、什么时候该发"
 * 得真看一眼图才知道。这里拿视觉模型逐张读图，产出四样东西：
 *
 *   tags     —— 英文小写标签，模型用 `[表情:标签]` 引用它
 *   desc     —— 一句话说清图里是什么（会进提示词，所以要求极短）
 *   useWhen  —— 什么情境下适合发
 *   emotions —— 对应情绪，供纯规则的自动补图使用
 *
 * 结果写进 manifest，之后不必重跑。已经识别过的默认跳过（force 可强制重跑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import type { ChatMessage, StickerEntry } from '../core/types.js';
import type { ProviderManager } from '../llm/manager.js';
import { sniffMime } from '../llm/vision.js';
import type { StickerView, StickerLibrary } from './stickers.js';

/**
 * 允许的情绪集合。
 * 限定成固定集合，是为了让 emotions 能跟 `EmotionAnalyzer` 的输出对得上 ——
 * 否则模型写"开心"，情绪分析器写"joy"，自动补图就永远命不中。
 */
export const STICKER_EMOTIONS = [
  'joy',
  'sadness',
  'anger',
  'fear',
  'surprise',
  'disgust',
  'neutral',
  'love',
  'shy',
  'tired',
] as const;

const ANALYZE_PROMPT = [
  '你在给聊天机器人整理表情包库。请仔细看这张图，然后输出严格 JSON（不要 markdown 代码块、不要解释）。',
  '',
  '字段要求：',
  '- tags: 1~3 个英文小写标签（只用 a-z 0-9 _ ），描述这张图表达什么情绪或反应，例如 happy / speechless / cry_laugh / thumbs_up',
  '- desc: 一句话说清画面内容和表情（中文，**不超过 20 个字**），例如「鲸鱼竖大拇指，得意地笑」',
  '- useWhen: 什么聊天情境适合发这张（中文，不超过 25 个字），例如「表示赞同或夸奖对方时」',
  `- emotions: 从这些里选 1~3 个最贴的：${STICKER_EMOTIONS.join(', ')}`,
  '',
  '只输出 JSON，形如：',
  '{"tags":["happy"],"desc":"鲸鱼竖大拇指得意地笑","useWhen":"赞同或夸奖对方时","emotions":["joy"]}',
].join('\n');

export interface AnalyzeResult {
  /** 参与识别的张数 */
  total: number;
  /** 成功写入的 */
  ok: number;
  /** 失败的 */
  failed: number;
  /** 跳过的（已识别过且未 force） */
  skipped: number;
  errors: string[];
  /** 结果预览，供面板展示 */
  preview: Array<{ file: string; tags: string[]; desc: string }>;
  /** 使用的模型 */
  model: string;
}

export interface AnalyzeOptions {
  /** 强制重跑已识别过的 */
  force?: boolean;
  /** 最多处理几张（避免一次跑几百张把额度烧光） */
  limit?: number;
  /** 指定文件（相对路径），不传则处理所有待识别的 */
  files?: string[];
  /** 并发数，默认 2（视觉模型通常配额紧，别太猛） */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, current: string) => void;
}

/**
 * 逐张识别。单张失败不影响其它张 —— 表情包是"锦上添花"，
 * 不能因为一张图读不出来就让整批导入作废。
 */
export async function analyzeStickers(
  providers: ProviderManager,
  lib: StickerLibrary,
  log: Logger,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const role = providers.resolveRole('vision');
  const model = `${role.provider}/${role.model}`;
  const out: AnalyzeResult = {
    total: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    preview: [],
    model,
  };

  // ---- 挑选目标 ----
  let targets: StickerView[];
  if (opts.files?.length) {
    targets = opts.files
      .map((f) => lib.get(f))
      .filter((s): s is StickerView => Boolean(s) && !s!.missing);
  } else {
    targets = lib.usable();
  }
  if (!opts.force) {
    const before = targets.length;
    targets = targets.filter((s) => !s.desc.trim());
    out.skipped = before - targets.length;
  }
  if (opts.limit && targets.length > opts.limit) {
    targets = targets.slice(0, opts.limit);
  }

  out.total = targets.length;
  if (out.total === 0) {
    log.info({ model }, '没有需要识别的表情包');
    return out;
  }

  log.info({ total: out.total, model }, `开始识别 ${out.total} 张表情包`);

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 2, 4));
  let done = 0;
  let cursor = 0;
  const collected: StickerEntry[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const i = cursor++;
      if (i >= targets.length) return;
      const item = targets[i]!;
      opts.onProgress?.(++done, targets.length, item.file);

      try {
        const meta = await analyzeOne(providers, role.provider, role.model, item, log);
        collected.push({
          file: item.file,
          tags: meta.tags,
          desc: meta.desc,
          useWhen: meta.useWhen,
          emotions: meta.emotions,
          source: item.source,
          ...(item.resId ? { resId: item.resId } : {}),
          ...(item.md5 ? { md5: item.md5 } : {}),
          ...(item.emojiId ? { emojiId: item.emojiId } : {}),
          ...(item.url ? { url: item.url } : {}),
          analyzedAt: Date.now(),
          analyzedBy: model,
        });
        out.ok++;
        if (out.preview.length < 12) {
          out.preview.push({ file: item.file, tags: meta.tags, desc: meta.desc });
        }
      } catch (e) {
        out.failed++;
        const msg = `${item.file}: ${(e as Error).message}`;
        if (out.errors.length < 10) out.errors.push(msg);
        log.warn({ file: item.file, err: (e as Error).message }, '表情包识别失败');
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // 每批只写一次 manifest，避免 N 次重载
  if (collected.length > 0) {
    lib.upsert(collected);
  }

  log.info({ ok: out.ok, failed: out.failed, model }, `表情包识别完成：成功 ${out.ok}，失败 ${out.failed}`);
  return out;
}

/** 识别单张 */
async function analyzeOne(
  providers: ProviderManager,
  provider: string,
  model: string,
  item: StickerView,
  log: Logger,
): Promise<{ tags: string[]; desc: string; useWhen: string; emotions: string[] }> {
  const buf = fs.readFileSync(item.absPath);
  const mimeType = sniffMime(buf);

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: ANALYZE_PROMPT },
        { type: 'image', mimeType, data: buf.toString('base64') },
      ],
    },
  ];

  const baseBudget = 600;
  const call = (maxTokens: number) =>
    providers.chat(messages, provider, model, { temperature: 0.2, maxTokens });

  let res = await call(baseBudget);

  // 推理模型（deepseek-flash / *-thinking 等）会先输出思维链，
  // 预算偏小时整段花在思考上、正文为空。**这时绝不能拿 reasoning 当答案**——
  // 那是它在复述任务，不是结果，硬解析只会得到"无法解析 JSON"。
  // 正确做法跟回复管线一致：用更大预算重试一次。
  if (!res.content.trim() && (res.reasoning?.length ?? 0) > 0) {
    log.debug(
      { file: item.file, model, maxTokens: baseBudget, reasoningChars: res.reasoning!.length },
      '视觉模型只产出了思考内容，用更大预算重试',
    );
    res = await call(baseBudget * 3);
  }

  const text = res.content.trim();
  if (!text) {
    throw new Error(
      (res.reasoning?.length ?? 0) > 0
        ? `模型只返回了思考内容（${res.reasoning!.length} 字）而没有结果，重试后仍为空。建议换一个非推理的视觉模型`
        : '模型返回空内容',
    );
  }

  // 偶发情况：模型把 JSON 塞在思考里、正文只留一句话。这时才去 reasoning 里捞。
  const parsed = parseJsonLoose(text) ?? (res.reasoning ? parseJsonLoose(res.reasoning) : null);
  if (!parsed) throw new Error(`无法解析 JSON：${text.slice(0, 80)}`);

  const tags = normalizeTags(parsed['tags']);
  const desc = String(parsed['desc'] ?? '').trim().slice(0, 40);
  const useWhen = String(parsed['useWhen'] ?? parsed['use_when'] ?? '').trim().slice(0, 50);
  const emotions = normalizeEmotions(parsed['emotions']);

  // 标签全丢时用文件名兜底 —— 但**只对命名有意义的本地文件**。
  // 从 QQ 导入的文件叫 qq_<md5>，拿它当标签只会得到一个哈希垃圾标签
  // （模型可能真的写出 [表情:qq_deadbeef]），不如让它保持无标签。
  if (tags.length === 0 && item.source !== 'qq') {
    const fallback = item.tags[0];
    if (fallback && !looksLikeHash(fallback)) {
      tags.push(fallback);
      log.debug({ file: item.file }, '识别没给出标签，用文件名标签兜底');
    }
  }

  return { tags, desc, useWhen, emotions };
}

/** qq_ab12cd34 这种哈希当标签毫无意义，识别它以免污染标签表 */
function looksLikeHash(tag: string): boolean {
  return /^[a-z0-9_]*[0-9a-f]{6,}$/i.test(tag) || /^qq_/i.test(tag);
}

/**
 * 宽松解析 JSON：模型经常包一层 ```json、或者前后带解释。
 * 先直接 parse，失败再抠第一个 { 到最后一个 }。
 */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const attempts: string[] = [];

  // 去掉 markdown 代码围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) attempts.push(fence[1].trim());
  attempts.push(text.trim());

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1));

  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* 试下一种 */
    }
  }
  return null;
}

/** 标签规整：小写、只留 a-z0-9_、去重、最多 3 个 */
export function normalizeTags(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，\s]+/) : [];
  const out: string[] = [];
  for (const v of arr) {
    const t = String(v)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 24);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

/** 情绪规整：只保留固定集合里的，映射常见同义词 */
export function normalizeEmotions(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，\s]+/) : [];
  const alias: Record<string, string> = {
    happy: 'joy',
    happiness: 'joy',
    joy: 'joy',
    excited: 'joy',
    sad: 'sadness',
    sadness: 'sadness',
    angry: 'anger',
    anger: 'anger',
    mad: 'anger',
    fear: 'fear',
    scared: 'fear',
    surprise: 'surprise',
    surprised: 'surprise',
    shock: 'surprise',
    disgust: 'disgust',
    neutral: 'neutral',
    love: 'love',
    like: 'love',
    shy: 'shy',
    embarrassed: 'shy',
    tired: 'tired',
    sleepy: 'tired',
  };
  const out: string[] = [];
  for (const v of arr) {
    const k = String(v).toLowerCase().trim();
    const mapped = alias[k];
    const e = mapped ?? ((STICKER_EMOTIONS as readonly string[]).includes(k) ? k : '');
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

/** 表情包目录里允许的文件名（面板上传/删除时的安全校验） */
export function safeRelPath(root: string, rel: string): string | null {
  const p = path.resolve(root, rel);
  const r = path.resolve(root);
  if (p !== r && !p.startsWith(r + path.sep)) return null;
  return p;
}
