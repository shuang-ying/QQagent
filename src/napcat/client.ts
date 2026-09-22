/**
 * NapCat / OneBot 11 WebSocket 客户端
 *
 * 以「反向连入」方式连接 NapCat 的 WS 服务端：
 *   Agent --ws--> NapCat(ws://127.0.0.1:3001)
 *
 * 能力：
 *  - 自动重连（指数退避）
 *  - 心跳检测 + 断线判定
 *  - echo 响应匹配（Promise 化动作调用）
 *  - 事件分发（message / notice / meta_event）
 *  - Access Token 鉴权（Authorization: Bearer）
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from '../core/logger.js';
import type { AppConfig, ObEvent, OneBotResponse, PokeEvent } from '../core/types.js';
import { OneBotAction } from './action.js';
import { normalizeMessageEvent, normalizePokeEvent } from './normalize.js';

export interface NapCatClientEvents {
  /** 收到并归一化后的消息 */
  message: [ReturnType<typeof normalizeMessageEvent>];
  /** 收到戳一戳 */
  poke: [PokeEvent];
  /** 原始 OneBot 事件 */
  event: [ObEvent];
  /** 连接就绪（已拿到 login_info 或至少连接成功） */
  ready: [{ selfId: number; nickname: string }];
  /** 连接断开 */
  disconnected: [{ code: number; reason: string }];
  /** 重连中 */
  reconnecting: [{ attempt: number; delayMs: number }];
}

type PendingResolver = {
  resolve: (r: OneBotResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class NapCatClient extends EventEmitter<NapCatClientEvents> {
  private ws: WebSocket | null = null;
  private action: OneBotAction;
  private pending = new Map<string, PendingResolver>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private closedByUser = false;

  public selfId = 0;
  public nickname = '';
  public connected = false;

  constructor(
    private readonly cfg: AppConfig['napcat'],
    private readonly log: Logger,
  ) {
    super();
    this.action = new OneBotAction(
      (payload) => this.rawSend(payload),
      (echo, timeoutMs) => this.waitForResponse(echo, timeoutMs),
      log,
    );
  }

  /** 暴露动作调用器 */
  get api(): OneBotAction {
    return this.action;
  }

  /** 启动连接 */
  start(): void {
    if (!this.cfg.enabled) {
      this.log.info('NapCat 接入已禁用（napcat.enabled=false），跳过连接');
      return;
    }
    this.closedByUser = false;
    this.connect();
  }

  /** 主动关闭，不再重连 */
  stop(): void {
    this.closedByUser = true;
    this.clearTimers();
    // 拒绝所有等待中的请求
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('客户端正在关闭'));
    }
    this.pending.clear();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close(1000, 'client shutdown');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.connected = false;
  }

  // ==================== 连接管理 ====================

  private connect(): void {
    const url = this.cfg.url;
    this.log.info({ url }, '正在连接 NapCat ...');

    const headers: Record<string, string> = {};
    if (this.cfg.accessToken) {
      headers['Authorization'] = `Bearer ${this.cfg.accessToken}`;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers, handshakeTimeout: 15000 });
    } catch (e) {
      this.log.error({ err: (e as Error).message }, '创建 WebSocket 失败');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastPongAt = Date.now();
      this.log.info({ url }, '✅ 已连接 NapCat');
      this.startHeartbeat();
      void this.onConnected();
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.handleRawMessage(data);
    });

    ws.on('error', (err: Error) => {
      this.log.warn({ err: err.message }, 'NapCat WebSocket 错误');
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString?.() || '';
      this.connected = false;
      this.clearTimers();
      this.emit('disconnected', { code, reason: reasonStr });
      if (this.closedByUser) {
        this.log.info('NapCat 连接已关闭（主动）');
        return;
      }
      this.log.warn({ code, reason: reasonStr }, 'NapCat 连接断开');
      this.scheduleReconnect();
    });
  }

  private async onConnected(): Promise<void> {
    try {
      const info = await this.action.getLoginInfo({ timeoutMs: 10000, throwOnError: true });
      this.selfId = Number(info.user_id) || this.cfg.selfId || 0;
      this.nickname = info.nickname || '';
      this.log.info({ selfId: this.selfId, nickname: this.nickname }, '🤖 机器人账号已就绪');
      this.emit('ready', { selfId: this.selfId, nickname: this.nickname });
    } catch (e) {
      // 拿不到 login_info 不算致命：某些实现可能不支持，退回配置值
      this.selfId = this.cfg.selfId;
      this.log.warn(
        { err: (e as Error).message, fallbackSelfId: this.selfId },
        '获取登录信息失败，使用配置中的 selfId（若为 0 将无法识别 @机器人）',
      );
      this.emit('ready', { selfId: this.selfId, nickname: '' });
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const { initialMs, maxMs, factor } = this.cfg.reconnect;
    const delay = Math.min(initialMs * Math.pow(factor, this.reconnectAttempt), maxMs);
    this.reconnectAttempt++;
    this.emit('reconnecting', { attempt: this.reconnectAttempt, delayMs: Math.round(delay) });
    this.log.info(
      { attempt: this.reconnectAttempt, delayMs: Math.round(delay) },
      `${(delay / 1000).toFixed(1)}s 后重连 NapCat`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ==================== 心跳 ====================

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const { intervalMs, timeoutMs } = this.cfg.heartbeat;

    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPongAt > timeoutMs + intervalMs) {
        this.log.warn(
          { silentMs: Date.now() - this.lastPongAt },
          '心跳超时，判定连接已死，主动断开以触发重连',
        );
        try {
          this.ws?.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      // 用轻量 API 作为心跳探测；失败也无妨，超时判定兜底
      void this.action.getStatus({ timeoutMs: timeoutMs }).catch(() => undefined);
    }, intervalMs);
  }

  // ==================== 收发 ====================

  private rawSend(payload: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(payload);
      return true;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, '发送失败');
      return false;
    }
  }

  private waitForResponse(echo: string, timeoutMs: number): Promise<OneBotResponse> {
    return new Promise<OneBotResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`等待 ${echo} 响应超时`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
    });
  }

  private handleRawMessage(data: WebSocket.RawData): void {
    this.lastPongAt = Date.now();
    const text = typeof data === 'string' ? data : data.toString('utf8');
    if (!text) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log.debug({ preview: text.slice(0, 200) }, '收到非 JSON 数据，已忽略');
      return;
    }

    // 可能是单个对象，也可能是数组（NapCat 某些配置下批量上报）
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      this.dispatch(item as Record<string, unknown>);
    }
  }

  private dispatch(obj: Record<string, unknown>): void {
    // 1) 动作响应（带 echo 且无 post_type）
    const echo = obj['echo'];
    if (typeof echo === 'string' && obj['post_type'] === undefined) {
      const p = this.pending.get(echo);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(echo);
        p.resolve(obj as unknown as OneBotResponse);
        return;
      }
      this.log.debug({ echo }, '收到未知 echo 的响应，已忽略');
      return;
    }

    // 2) 事件
    const postType = obj['post_type'];
    if (typeof postType !== 'string') {
      this.log.debug({ keys: Object.keys(obj).slice(0, 8) }, '无法识别的消息，已忽略');
      return;
    }

    const ev = obj as unknown as ObEvent;
    this.emit('event', ev);

    if (postType === 'message' || postType === 'message_sent') {
      // message_sent 是机器人自己发的消息，用于记录但不触发生成
      if (postType === 'message') {
        try {
          const msg = normalizeMessageEvent(ev as never);
          this.log.debug(
            {
              scope: msg.scope,
              from: `${msg.senderName}(${msg.userId})`,
              text: msg.text.slice(0, 80),
              mentionsBot: msg.mentionsBot,
            },
            '收到消息',
          );
          this.emit('message', msg);
        } catch (e) {
          this.log.warn({ err: (e as Error).message }, '消息归一化失败');
        }
      }
    } else if (postType === 'meta_event') {
      const metaType = obj['meta_event_type'];
      if (metaType === 'heartbeat') {
        this.lastPongAt = Date.now();
        this.log.trace('收到 NapCat 心跳');
      } else if (metaType === 'lifecycle') {
        this.log.info({ sub: obj['sub_type'] }, 'NapCat 生命周期事件');
      }
    } else if (postType === 'notice') {
      // 戳一戳等通知事件：归一化后抛给上层处理
      try {
        const poke = normalizePokeEvent(obj as never);
        if (poke) {
          this.log.debug(
            { scope: poke.scope, from: poke.userId, target: poke.targetId },
            '收到戳一戳',
          );
          this.emit('poke', poke);
        } else {
          this.log.debug({ noticeType: obj['notice_type'], sub: obj['sub_type'] }, '收到其它通知事件');
        }
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, '通知事件归一化失败');
      }
    }
  }
}
