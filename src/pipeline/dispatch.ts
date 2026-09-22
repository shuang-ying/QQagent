/**
 * 回复分发器：把「一段文本」变成「像真人那样发出去的消息」
 *
 * 参考 AstrBot 的 respond stage，做了三件事：
 *  1. 头部段（引用 + @）只挂在**第一条**消息上，不重复
 *  2. 分条发送：把长回复按自然断点拆成几条，中间停顿
 *  3. 停顿算法：log 模式按字数算（字越多等越久，但增长次线性），更像真人打字
 *
 * 还有两个"像人"的小动作：被戳戳回去、给消息点表情回应。
 */
import type { Logger } from '../core/logger.js';
import type { ObMessageSegment, ReplyBehavior } from '../core/types.js';
import type { OneBotAction } from '../napcat/action.js';
import { atSegment, buildReplySegments, replySegment, textSegment } from '../napcat/action.js';
import { readFile, access, constants } from 'node:fs/promises';

export interface DispatchContext {
  scope: string;
  scopeType: 'private' | 'group';
  /** 对方 QQ（用于 @） */
  userId: number;
  /** 触发本次回复的消息 id（用于引用） */
  messageId?: number;
  /** 是否 @ 了机器人（群里被 @ 时回复通常也该 @ 回去） */
  mentionsBot?: boolean;
}

export interface DispatchResult {
  /** 实际发出的消息条数 */
  sent: number;
  /** 失败条数 */
  failed: number;
  /** 每条的延时（毫秒），便于日志与测试 */
  delays: number[];
}

export class ReplyDispatcher {
  constructor(
    private readonly cfg: ReplyBehavior,
    private readonly log: Logger,
  ) {}

  /**
   * 按字数计算"打字"停顿（毫秒）。参照 AstrBot：
   *   log 模式：log(字数+1, logBase) 秒，再叠加 0~0.5s 抖动
   *   random 模式：在配置区间内随机
   * 纯符号/表情这类没有"字数"的段用固定短停顿。
   */
  computeDelay(text: string): number {
    const seg = this.cfg.segmented;

    if (seg.intervalMethod === 'random') {
      const [lo, hi] = seg.interval;
      const a = lo ?? 1.5;
      const b = hi ?? 3.5;
      const t = b > a ? a + Math.random() * (b - a) : a;
      return Math.round(t * 1000);
    }

    // log 模式
    const wc = wordCount(text);
    if (wc === 0) {
      // 纯表情/符号：给个短抖动
      return Math.round((1 + Math.random() * 0.75) * 1000);
    }
    const base = seg.logBase > 1 ? seg.logBase : 2.3;
    const i = Math.log(wc + 1) / Math.log(base);
    return Math.round((i + Math.random() * 0.5) * 1000);
  }

  /**
   * 把回复拆成若干条。
   * 优先按换行，其次按句末标点；太短或条数超限就不拆。
   */
  splitForHuman(text: string): string[] {
    const seg = this.cfg.segmented;
    if (!seg.enabled) return [text];
    if (text.length < seg.minCharsToSplit) return [text];

    // 先按换行分（模型用换行分段通常是有意的）
    let parts = text
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

    // 段落太长再按句末标点拆
    if (parts.length === 1) {
      parts = splitBySentence(text);
    }

    if (parts.length <= 1) return [text];

    // 超出上限：把多余的合并到最后一条，避免刷屏
    if (parts.length > seg.maxSegments) {
      const head = parts.slice(0, seg.maxSegments - 1);
      const tail = parts.slice(seg.maxSegments - 1).join('\n');
      parts = [...head, tail];
    }

    // 过滤掉拆分后产生的空片段
    const cleaned = parts.filter((p) => p.trim().length > 0);
    return cleaned.length > 0 ? cleaned : [text];
  }

  /**
   * 发送一条回复。
   * @param single 强制单条发送（忽略分条设置），用于命令回复等场景
   */
  async send(
    api: OneBotAction,
    ctx: DispatchContext,
    text: string,
    opts: { single?: boolean } = {},
  ): Promise<DispatchResult> {
    const out: DispatchResult = { sent: 0, failed: 0, delays: [] };
    if (!text.trim()) return out;

    // ---- 头部段：引用 + @（只挂第一条）----
    const head: { quoteMessageId?: number; mentionUserId?: number } = {};
    if (this.cfg.quoteOnReply && ctx.messageId) head.quoteMessageId = ctx.messageId;
    // 群里才 @；私聊没必要
    if (this.cfg.mentionOnReply && ctx.scopeType === 'group') head.mentionUserId = ctx.userId;

    const segments = opts.single ? [text] : this.splitForHuman(text);

    for (let i = 0; i < segments.length; i++) {
      const piece = segments[i]!;
      const isFirst = i === 0;

      // 分条时后续条也要走"打字"停顿；第一条之前如果有整体思考延迟也已经等过了
      if (i > 0) {
        const delay = this.computeDelay(piece);
        out.delays.push(delay);
        await sleep(delay);
      }

      // @ 只在群里、且对方不是机器人自己时加
      const mention = isFirst ? head.mentionUserId : undefined;
      const quote = isFirst ? head.quoteMessageId : undefined;

      const payload: ObMessageSegment[] = buildReplySegments(piece, {
        ...(quote !== undefined ? { quoteMessageId: quote } : {}),
        ...(mention !== undefined ? { mentionUserId: mention } : {}),
      });

      try {
        await api.sendToScope(ctx.scope, payload, { throwOnError: true });
        out.sent++;
      } catch (e) {
        out.failed++;
        this.log.warn(
          { scope: ctx.scope, index: i, err: (e as Error).message },
          '发送消息失败',
        );
        // 若带 @/引用 的整段被拒（部分实现不支持 reply 段），退化为纯文本再试一次
        if (isFirst && (quote !== undefined || mention !== undefined)) {
          try {
            await api.sendToScope(ctx.scope, piece, { throwOnError: true });
            out.sent++;
            out.failed--;
            this.log.info({ scope: ctx.scope }, '退化为纯文本发送成功');
          } catch {
            /* 仍然失败就放弃这一条 */
          }
        }
      }
    }

    this.log.debug(
      { scope: ctx.scope, parts: segments.length, sent: out.sent, delays: out.delays },
      '回复已分发',
    );
    return out;
  }

  /** 整体回复前的"思考"延迟（让人感觉在想而不是秒回） */
  async thinkDelay(): Promise<number> {
    const [lo, hi] = this.cfg.typingDelayMs;
    const a = lo ?? 0;
    const b = hi ?? 0;
    if (b <= 0) return 0;
    const ms = b > a ? Math.round(a + Math.random() * (b - a)) : a;
    if (ms > 0) await sleep(ms);
    return ms;
  }

  /**
   * 被戳一戳时的反应：戳回去（可选再说一句话）。
   * 失败不抛异常 —— 有些实现不支持 friend_poke。
   */
  async reactToPoke(
    api: OneBotAction,
    ev: { scope: string; scopeType: 'private' | 'group'; userId: number },
    speak?: string,
  ): Promise<{ poked: boolean; said: boolean }> {
    let poked = false;
    let said = false;

    if (this.cfg.pokeBack) {
      try {
        await api.poke(ev.scope, ev.userId, { throwOnError: true });
        poked = true;
      } catch (e) {
        this.log.debug({ scope: ev.scope, err: (e as Error).message }, '戳回去失败（实现可能不支持）');
      }
    }

    if (this.cfg.pokeReply && speak?.trim()) {
      // 戳一戳的回应也走 @（群里）
      const segs: ObMessageSegment[] =
        ev.scopeType === 'group'
          ? [atSegment(ev.userId), textSegment(' ' + speak.trim())]
          : [textSegment(speak.trim())];
      try {
        await api.sendToScope(ev.scope, segs, { throwOnError: true });
        said = true;
      } catch (e) {
        this.log.warn({ scope: ev.scope, err: (e as Error).message }, '戳后说话失败');
      }
    }

    return { poked, said };
  }

  /** 给消息点个表情回应 */
  async likeMessage(api: OneBotAction, messageId: number): Promise<boolean> {
    if (!this.cfg.emojiLike.enabled) return false;
    try {
      await api.setMsgEmojiLike(messageId, this.cfg.emojiLike.emojiId, { throwOnError: true });
      return true;
    } catch (e) {
      this.log.debug({ messageId, err: (e as Error).message }, '表情回应失败');
      return false;
    }
  }

  /**
   * 发送一张表情包。
   *
   * 优先用本地路径（NapCat 与本程序同机，直接读文件最高效）。
   * 若路径方式失败（有些实现只认 base64/URL），退化为 base64 内联再试一次。
   */
  async sendSticker(api: OneBotAction, scope: string, file: string): Promise<boolean> {
    // 先确认文件真的在：否则只能等 NapCat 报错，日志里看不出原因
    try {
      await access(file, constants.R_OK);
    } catch {
      this.log.warn({ scope, file }, '表情包文件不存在或不可读，跳过');
      return false;
    }

    // 1) 本地路径
    try {
      await api.sendToScope(scope, [{ type: 'image', data: { file } }], { throwOnError: true });
      return true;
    } catch (e) {
      this.log.debug({ scope, file, err: (e as Error).message }, '表情包按路径发送失败，改用 base64');
    }

    // 2) base64 兜底
    try {
      const buf = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      const mime =
        ext === '.png' ? 'image/png'
          : ext === '.gif' ? 'image/gif'
            : ext === '.webp' ? 'image/webp'
              : ext === '.bmp' ? 'image/bmp'
                : 'image/jpeg';
      await api.sendToScope(
        scope,
        [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }],
        { throwOnError: true },
      );
      return true;
    } catch (e) {
      this.log.warn({ scope, file, err: (e as Error).message }, '表情包发送失败');
      return false;
    }
  }
}

/** 通用戳一戳回应池（人格没配时用） */
export const GENERIC_POKE_LINES = [
  '干嘛呀~',
  '在呢在呢，别戳啦',
  '戳我做什么喵？',
  '诶？找我有事吗',
  '别戳了别戳了，痒',
  '嗯？我在的',
];

/** 挑一句戳一戳的回应：优先人格自定义，否则用通用池 */
export function pickPokeLine(persona?: { pokeReplies?: string[] }): string {
  const pool = persona?.pokeReplies?.length ? persona.pokeReplies : GENERIC_POKE_LINES;
  const i = Math.floor(Math.random() * pool.length);
  return pool[i] ?? GENERIC_POKE_LINES[0]!;
}

/** 中英文字数统计：英文按词，中文按字（与 AstrBot 一致） */
export function wordCount(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  // 全 ASCII 就按词数
  if (/^[\x00-\x7F]*$/.test(t)) {
    return t.split(/\s+/).filter(Boolean).length;
  }
  // 含中文：统计字母数字字符（中文每个字算一个）
  const m = t.match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

/** 按句末标点拆句，并合并过短的句子 */
export function splitBySentence(text: string): string[] {
  const raw = text
    .split(/(?<=[。！？!?…~～])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length <= 1) return raw;

  // 相邻短句合并，避免出现"嗯。"这种碎片。
  // 阈值要小：中文一句话本来就短（"第一句。"只有 4 字），
  // 阈值太大反而会把整段吞成一条，分条就失效了。
  const MIN = 5;
  const out: string[] = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    // 只在"已累积的那条还太短"时继续吸收，避免无限合并
    if (last !== undefined && last.length < MIN) {
      out[out.length - 1] = last + s;
    } else {
      out.push(s);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
