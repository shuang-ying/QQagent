/**
 * OneBot 11 动作调用器
 *
 * 封装发送消息、获取群成员等 API，统一处理 echo 匹配、超时、错误。
 */
import type { Logger } from '../core/logger.js';
import type { ObMessageSegment, OneBotResponse, QqFavEmoji } from '../core/types.js';
import { toCqCodes } from './normalize.js';

export interface ActionOptions {
  timeoutMs?: number;
  /** 是否把失败当作异常抛出 */
  throwOnError?: boolean;
}

export class OneBotActionError extends Error {
  constructor(
    public readonly action: string,
    public readonly status: string,
    public readonly retcode: number,
    message: string,
  ) {
    super(`OneBot 调用失败 [${action}] status=${status} retcode=${retcode}: ${message}`);
    this.name = 'OneBotActionError';
  }
}

/** 由 WsClient 注入的发送函数 */
export type RawSender = (payload: string) => boolean;
/** 由 WsClient 注入的等待响应函数 */
export type ResponseWaiter = (echo: string, timeoutMs: number) => Promise<OneBotResponse>;

export class OneBotAction {
  private echoSeq = 0;

  constructor(
    private readonly send: RawSender,
    private readonly wait: ResponseWaiter,
    private readonly log: Logger,
    private readonly defaultTimeoutMs = 30000,
  ) {}

  /** 生成唯一 echo 标识 */
  private nextEcho(): string {
    return `${Date.now().toString(36)}-${(++this.echoSeq).toString(36)}`;
  }

  /** 调用任意 OneBot 动作 */
  async call<T = unknown>(action: string, params: Record<string, unknown> = {}, opts: ActionOptions = {}): Promise<T> {
    const echo = this.nextEcho();
    const payload = JSON.stringify({ action, params, echo });

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const waiter = this.wait(echo, timeoutMs);
    const sent = this.send(payload);
    if (!sent) {
      throw new OneBotActionError(action, 'failed', -1, 'WebSocket 未连接，消息未发出');
    }

    let resp: OneBotResponse;
    try {
      resp = await waiter;
    } catch (e) {
      throw new OneBotActionError(action, 'failed', -1, `等待响应超时(${timeoutMs}ms) 或连接中断`);
    }

    if (resp.status !== 'ok' || resp.retcode !== 0) {
      const msg = resp.wording || resp.msg || `retcode=${resp.retcode}`;
      if (opts.throwOnError) {
        throw new OneBotActionError(action, resp.status, resp.retcode, msg);
      }
      this.log.warn({ action, status: resp.status, retcode: resp.retcode, msg }, 'OneBot 动作返回非成功');
    }
    return resp.data as T;
  }

  // ==================== 消息发送 ====================

  /** 发送私聊消息 */
  async sendPrivateMsg(userId: number, message: string | ObMessageSegment[], opts?: ActionOptions) {
    return this.call<{ message_id: number }>(
      'send_private_msg',
      { user_id: userId, message: typeof message === 'string' ? message : toCqCodes(message) },
      opts,
    );
  }

  /** 发送群消息 */
  async sendGroupMsg(groupId: number, message: string | ObMessageSegment[], opts?: ActionOptions) {
    return this.call<{ message_id: number }>(
      'send_group_msg',
      { group_id: groupId, message: typeof message === 'string' ? message : toCqCodes(message) },
      opts,
    );
  }

  /** 按 scope 自动选择群/私聊发送 */
  async sendToScope(
    scope: string,
    message: string | ObMessageSegment[],
    opts?: ActionOptions,
  ): Promise<{ message_id: number }> {
    const [type, idStr] = scope.split(':');
    const id = Number(idStr);
    if (!Number.isFinite(id)) throw new Error(`非法 scope: ${scope}`);
    return type === 'group' ? this.sendGroupMsg(id, message, opts) : this.sendPrivateMsg(id, message, opts);
  }

  /** 撤回消息 */
  async deleteMsg(messageId: number, opts?: ActionOptions) {
    return this.call('delete_msg', { message_id: messageId }, opts);
  }

  // ==================== 信息查询 ====================

  async getLoginInfo(opts?: ActionOptions) {
    return this.call<{ user_id: number; nickname: string }>('get_login_info', {}, opts);
  }

  async getGroupList(opts?: ActionOptions) {
    return this.call<Array<{ group_id: number; group_name: string; member_count: number }>>('get_group_list', {}, opts);
  }

  async getGroupInfo(groupId: number, opts?: ActionOptions) {
    return this.call<{ group_id: number; group_name: string; member_count: number; max_member_count: number }>(
      'get_group_info',
      { group_id: groupId },
      opts,
    );
  }

  async getGroupMemberInfo(groupId: number, userId: number, opts?: ActionOptions) {
    return this.call<{ user_id: number; nickname: string; card: string; role: string }>(
      'get_group_member_info',
      { group_id: groupId, user_id: userId },
      opts,
    );
  }

  async getFriendList(opts?: ActionOptions) {
    return this.call<Array<{ user_id: number; nickname: string; remark: string }>>('get_friend_list', {}, opts);
  }

  async getStatus(opts?: ActionOptions) {
    return this.call<{ online: boolean; good: boolean }>('get_status', {}, opts);
  }

  async getVersionInfo(opts?: ActionOptions) {
    return this.call<{ app_name: string; app_version: string; protocol_version: string }>('get_version_info', {}, opts);
  }

  /** 设置消息表情回应 */
  async setMsgEmojiLike(messageId: number, emojiId = '128077', opts?: ActionOptions) {
    return this.call('set_msg_emoji_like', { message_id: messageId, emoji_id: emojiId }, opts);
  }

  /** 群聊戳一戳 */
  async sendGroupPoke(groupId: number, userId: number, opts?: ActionOptions) {
    return this.call('group_poke', { group_id: groupId, user_id: userId }, opts);
  }

  /** 私聊戳一戳（部分实现用 friend_poke，失败时由调用方决定是否忽略） */
  async sendFriendPoke(userId: number, opts?: ActionOptions) {
    return this.call('friend_poke', { user_id: userId }, opts);
  }

  /** 按 scope 自动选择群/私聊戳一戳 */
  async poke(scope: string, userId: number, opts?: ActionOptions) {
    const [type, idStr] = scope.split(':');
    const id = Number(idStr);
    if (!Number.isFinite(id)) throw new Error(`非法 scope: ${scope}`);
    return type === 'group' ? this.sendGroupPoke(id, userId, opts) : this.sendFriendPoke(userId, opts);
  }

  // ==================== QQ 收藏表情（NapCat 扩展） ====================

  /**
   * 取当前 QQ 账号的**收藏表情**，返回图片 URL 列表。
   *
   * 这是 NapCat 的扩展动作（不是 OneBot 11 标准）。返回的 URL 是腾讯 CDN 地址，
   * **带时效**，过期就取不到了 —— 所以调用方必须尽快下载到本地。
   */
  async fetchCustomFace(count = 48, opts?: ActionOptions): Promise<string[]> {
    const data = await this.call<unknown>('fetch_custom_face', { count }, opts);
    if (!Array.isArray(data)) return [];
    return data.map((u) => String(u)).filter((u) => u.length > 0);
  }

  /**
   * 取收藏表情的**详情**（含 resId / md5 / desc），用于增量导入去重。
   *
   * 不同 NapCat 版本字段名不完全一致，这里做宽松归一化：
   * 拿不到详情时退化成只有 url，调用方仍能工作。
   */
  async fetchCustomFaceDetail(count = 48, opts?: ActionOptions): Promise<QqFavEmoji[]> {
    const data = await this.call<unknown>('fetch_custom_face_detail', { count }, opts);
    if (!Array.isArray(data)) return [];

    return data.map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const pick = (...keys: string[]): string => {
        for (const k of keys) {
          const v = o[k];
          if (typeof v === 'string' && v.length > 0) return v;
          if (typeof v === 'number') return String(v);
        }
        return '';
      };
      return {
        url: pick('url', 'emojiUrl', 'fileUrl'),
        resId: pick('resId', 'res_id', 'resID'),
        md5: pick('md5', 'Md5', 'MD5'),
        emojiId: pick('emojiId', 'emoji_id', 'emojiID'),
        desc: pick('desc', 'description'),
      };
    });
  }

  /** 往 QQ 收藏里加一张表情（本地文件路径） */
  async addCustomFace(file: string, opts?: ActionOptions) {
    return this.call('add_custom_face', { file, is_origin: true }, opts);
  }

  /** 删除 QQ 收藏表情，传 resId 或 md5 */
  async deleteCustomFace(ids: { resId?: string[]; md5?: string[] }, opts?: ActionOptions) {
    return this.call(
      'delete_custom_face',
      {
        ...(ids.resId?.length ? { res_id: ids.resId } : {}),
        ...(ids.md5?.length ? { md5: ids.md5 } : {}),
      },
      opts,
    );
  }

  /**
   * 把 AI 生成的描述**回写进 QQ 自带的收藏表情描述**。
   * 这样在手机 QQ 里也能看到这张图是干嘛的 —— 顺手把两个世界对齐。
   */
  async setCustomFaceDesc(
    item: { emojiId: string; resId: string; md5: string; desc: string },
    opts?: ActionOptions,
  ) {
    return this.call(
      'set_custom_face_desc',
      { emoji_id: item.emojiId, res_id: item.resId, md5: item.md5, desc: item.desc },
      opts,
    );
  }
}

// ==================== 消息段构造 ====================

/** @某人 */
export function atSegment(userId: number | 'all'): ObMessageSegment {
  return { type: 'at', data: { qq: userId === 'all' ? 'all' : String(userId) } };
}

/** 引用回复某条消息 */
export function replySegment(messageId: number): ObMessageSegment {
  return { type: 'reply', data: { id: String(messageId) } };
}

/** 纯文本段 */
export function textSegment(text: string): ObMessageSegment {
  return { type: 'text', data: { text } };
}

/** 图片段（本地文件或 URL） */
export function imageSegment(file: string): ObMessageSegment {
  return { type: 'image', data: { file } };
}

/** 把回复正文与可选的「引用 + @」头部拼成消息段数组 */
export function buildReplySegments(
  text: string,
  head: { quoteMessageId?: number; mentionUserId?: number } = {},
): ObMessageSegment[] {
  const segs: ObMessageSegment[] = [];
  if (head.quoteMessageId !== undefined) segs.push(replySegment(head.quoteMessageId));
  if (head.mentionUserId !== undefined) segs.push(atSegment(head.mentionUserId), textSegment(' '));
  segs.push(textSegment(text));
  return segs;
}
