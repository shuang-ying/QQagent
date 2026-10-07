import { errorDetails } from '../core/logger.js';
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
import type { OneBotAction } from '../onebot/action.js';
import { atSegment, buildReplySegments, textSegment, OneBotActionError } from '../onebot/action.js';
import { readFile, access, constants } from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { splitMessage } from './segments.js';

export interface DispatchContext {
  scope: string;
  scopeType: 'private' | 'group';
  /** 对方 QQ（默认的 @ 对象） */
  userId: number;
  /** 触发本次回复的消息 id（默认的引用对象） */
  messageId?: number;
  /** 是否 @ 了机器人（群里被 @ 时回复通常也该 @ 回去） */
  mentionsBot?: boolean;
  /**
   * 显式指定 @ 谁，覆盖默认的 userId。
   *
   * 用途：主动搭话时"最后说话的人"往往不是机器人实际在回应的对象，
   * 由模型用 `[@名字]` 指明；`null` 表示**明确不要 @ 任何人**。
   */
  mentionUserId?: number | null;
  /** 显式指定引用哪条消息，覆盖默认的 messageId；null = 不引用 */
  quoteMessageId?: number | null;
}

export interface DispatchResult {
  state: 'success' | 'partial' | 'failed' | 'unknown';
  pieces: Array<{ content: string; state: 'success' | 'failed' | 'unknown'; messageId?: number }>;
  /** 实际发出的消息条数 */
  sent: number;
  /** 失败条数 */
  failed: number;
  /** 每条的延时（毫秒），便于日志与测试 */
  delays: number[];
}

export class ReplyDispatcher {
  snapshot(config: ReplyBehavior): ReplyDispatcher { return new ReplyDispatcher(config, this.log); }
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
    opts: { single?: boolean; signal?: AbortSignal } = {},
  ): Promise<DispatchResult> {
    const out: DispatchResult = { sent: 0, failed: 0, delays: [], state: 'failed', pieces: [] };
    if (!text.trim()) return out;

    // ---- 头部段：引用 + @（只挂第一条）----
    const head: { quoteMessageId?: number; mentionUserId?: number } = {};

    // 引用：显式指定优先（null = 不引用），否则用触发消息
    if (ctx.quoteMessageId === null) {
      // 明确不引用
    } else if (ctx.quoteMessageId !== undefined) {
      head.quoteMessageId = ctx.quoteMessageId;
    } else if (this.cfg.quoteOnReply && ctx.messageId) {
      head.quoteMessageId = ctx.messageId;
    }

    // @：群里才 @；私聊没必要。
    // 显式指定优先 —— 主动搭话靠这个避免"张冠李戴"；null = 明确不 @ 任何人。
    if (ctx.scopeType === 'group') {
      if (ctx.mentionUserId === null) {
        // 明确不 @
      } else if (ctx.mentionUserId !== undefined) {
        head.mentionUserId = ctx.mentionUserId;
      } else if (this.cfg.mentionOnReply) {
        head.mentionUserId = ctx.userId;
      }
    }

    const segments = (opts.single ? [text] : this.splitForHuman(text)).flatMap(part => splitMessage(part));

    for (let i = 0; i < segments.length; i++) {
      if (opts.signal?.aborted) { out.failed++; break; }
      const piece = segments[i]!;
      const isFirst = i === 0;

      // 分条时后续条也要走"打字"停顿；第一条之前如果有整体思考延迟也已经等过了
      if (i > 0) {
        const delay = this.cfg.segmented.enabled ? this.computeDelay(piece) : 300;
        out.delays.push(delay);
        try { await wait(delay, undefined, { signal: opts.signal }); }
        catch { out.failed++; break; }
        if (opts.signal?.aborted) { out.failed++; break; }
      }

      // @ 只在群里、且对方不是机器人自己时加
      const mention = isFirst ? head.mentionUserId : undefined;
      const quote = isFirst ? head.quoteMessageId : undefined;

      const payload: ObMessageSegment[] = buildReplySegments(piece, {
        ...(quote !== undefined ? { quoteMessageId: quote } : {}),
        ...(mention !== undefined ? { mentionUserId: mention } : {}),
      });

      try {
        const receipt = await api.sendToScope(ctx.scope, payload, { throwOnError: true });
        if (!Number.isFinite(receipt?.message_id)) throw new OneBotActionError('send', 'failed', -1, '发送响应缺少消息 ID', 'unknown');
        out.pieces.push({ content: piece, state: 'success', messageId: receipt?.message_id });
        out.sent++;
      } catch (e) {
        let delivered = false;
        const unknown = !(e instanceof OneBotActionError) || e.outcome === 'unknown';
        out.failed++;
        this.log.warn(
          { scope: ctx.scope, index: i, ...errorDetails(e), err: (e as Error).message },
          '发送消息失败',
        );
        // 若带 @/引用 的整段被拒（部分实现不支持 reply 段），退化为纯文本再试一次
        if (!unknown && isFirst && (quote !== undefined || mention !== undefined) && e instanceof OneBotActionError && e.retcode > 0) {
          try {
            const receipt = await api.sendToScope(ctx.scope, piece, { throwOnError: true });
            if (!Number.isFinite(receipt?.message_id)) throw new OneBotActionError('send', 'failed', -1, '发送响应缺少消息 ID', 'unknown');
            out.pieces.push({ content: piece, state: 'success', messageId: receipt?.message_id });
            delivered = true;
            out.sent++;
            out.failed--;
            this.log.info({ scope: ctx.scope }, '退化为纯文本发送成功');
          } catch (retryError) {
            out.pieces.push({ content: piece, state: retryError instanceof OneBotActionError && retryError.outcome === 'failed' ? 'failed' : 'unknown' });
            delivered = true;
          }
        }
        if (!delivered) out.pieces.push({ content: piece, state: unknown ? 'unknown' : 'failed' });
        if (out.pieces.at(-1)?.state !== 'success') break;
      }
    }

    this.log.debug(
      { scope: ctx.scope, parts: segments.length, sent: out.sent, delays: out.delays },
      '回复已分发',
    );
    out.state = out.pieces.some(p => p.state === 'unknown') ? 'unknown'
      : out.failed > 0 ? (out.sent > 0 ? 'partial' : 'failed') : 'success';
    return out;
  }

  /** 整体回复前的"思考"延迟（让人感觉在想而不是秒回） */
  async thinkDelay(signal?: AbortSignal): Promise<number> {
    const [lo, hi] = this.cfg.typingDelayMs;
    const a = lo ?? 0;
    const b = hi ?? 0;
    if (b <= 0) return 0;
    const ms = b > a ? Math.round(a + Math.random() * (b - a)) : a;
    if (ms > 0) await wait(ms, undefined, { signal });
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
        this.log.debug({ scope: ev.scope, ...errorDetails(e), err: (e as Error).message }, '戳回去失败（实现可能不支持）');
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
        this.log.warn({ scope: ev.scope, ...errorDetails(e), err: (e as Error).message }, '戳后说话失败');
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
      this.log.debug({ messageId, ...errorDetails(e), err: (e as Error).message }, '表情回应失败');
      return false;
    }
  }

  /**
   * 发送一张表情包。
   *
   * 优先用标准 file URI（OneBot 与本程序同机时可直接读文件）。
   * 若路径方式失败（有些实现只认 base64/URL），退化为 base64 内联再试一次。
   */
  async sendSticker(api: OneBotAction, scope: string, file: string, opts: {signal?:AbortSignal} = {}): Promise<boolean> {
    if (opts.signal?.aborted) return false;
    // 先确认文件真的在：否则只能等 NapCat 报错，日志里看不出原因
    try {
      await access(file, constants.R_OK);
    } catch {
      this.log.warn({ scope, file }, '表情包文件不存在或不可读，跳过');
      return false;
    }

    // 1) 本地路径
    try {
      if (opts.signal?.aborted) return false;
      const receipt = await api.sendToScope(scope, [{ type: 'image', data: { file:pathToFileURL(path.resolve(file)).href } }], { throwOnError: true });
      if (!Number.isSafeInteger(receipt?.message_id) || !receipt.message_id) {
        this.log.warn({scope,file,route:'file-uri',outcome:'unknown'}, '表情包回执缺少可靠消息ID，未重复发送');
        return false;
      }
      this.log.info({scope,file,route:'file-uri',messageId:receipt.message_id}, '表情包已确认投递');
      return true;
    } catch (e) {
      if (!(e instanceof OneBotActionError) || e.outcome === 'unknown') {
        this.log.warn({scope,file,outcome:'unknown',...errorDetails(e), reason: (e as Error).message}, '表情包投递结果未知，未重复发送');
        return false;
      }
      this.log.debug({ scope, file, ...errorDetails(e), err: (e as Error).message }, '表情包按路径发送失败，改用 base64');
    }

    // 2) base64 兜底
    try {
      const buf = await readFile(file);
      if (opts.signal?.aborted) return false;
      const receipt = await api.sendToScope(
        scope,
        [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }],
        { throwOnError: true },
      );
      if (!Number.isSafeInteger(receipt?.message_id) || !receipt.message_id) {
        this.log.warn({scope,file,route:'base64',outcome:'unknown'}, '表情包回执缺少可靠消息ID，未重复发送');
        return false;
      }
      this.log.info({scope,file,route:'base64',messageId:receipt.message_id}, '表情包已确认投递');
      return true;
    } catch (e) {
      this.log.warn({ scope, file, ...errorDetails(e), err: (e as Error).message }, '表情包发送失败');
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

