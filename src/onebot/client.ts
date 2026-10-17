/**
 * OneBot 11 WebSocket 客户端
 *
 * 以正向 WebSocket 连接 OneBot 实现的 WS 服务端：
 *   Agent --ws--> OneBot(ws://127.0.0.1:3001)
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
import { OneBotAction, OneBotActionError } from './action.js';
import { normalizeMessageEvent, normalizePokeEvent } from './normalize.js';

export interface OneBotClientEvents {
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
  generation: number;
  resolve: (r: OneBotResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class OneBotClient extends EventEmitter<OneBotClientEvents> {
  private ws: WebSocket | null = null;
  private action: OneBotAction;
  private pending = new Map<string, PendingResolver>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private closedByUser = false;
  private generation = 0;
  public accountReady = false;
  public apiReady = false;

  get health() { return { connected: this.connected, accountReady: this.accountReady, apiReady: this.apiReady,
    generation: this.generation, pending: this.pending.size, bufferedBytes: this.ws?.bufferedAmount ?? 0 }; }

  public selfId = 0;
  public nickname = '';
  public connected = false;
  public implementation = { name: '', version: '', protocol: '' };

  constructor(
    private readonly cfg: AppConfig['napcat'],
    private readonly log: Logger,
  ) {
    super();
    this.action = new OneBotAction(
      (payload) => this.rawSend(payload),
      (echo, timeoutMs) => this.waitForResponse(echo, timeoutMs),
      log,
      30000,
      (echo) => this.cancelPending(echo),
      cfg.extensions,
    );
  }

  /** 暴露动作调用器 */
  get api(): OneBotAction {
    return this.action;
  }

  /** 启动连接 */
  start(): void {
    if (this.ws || this.reconnectTimer) return;
    if (!this.cfg.enabled) {
      this.log.info('OneBot 接入已禁用（napcat.enabled=false），跳过连接');
      return;
    }
    this.closedByUser = false;
    this.connect();
  }

  /** 主动关闭，不再重连 */
  stop(): void {
    this.closedByUser = true;
    this.generation++;
    this.accountReady = false;
    this.apiReady = false;
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
        // 连接尚在握手时 close 会异步发出 error，仍须接住。
        this.ws.on('error', () => undefined);
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
    if (this.cfg.mode === 'ws-server') throw new Error('当前仅支持正向 WebSocket 客户端，请配置 mode: forward-ws');
    const url = this.cfg.url;
    this.log.info({ url }, '正在连接 OneBot ...');

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
    const generation = ++this.generation;
    const current = () => this.ws === ws && this.generation === generation && !this.closedByUser;

    ws.on('open', () => {
      if (!current()) return;
      this.connected = true;
      this.implementation = { name: '', version: '', protocol: '' };
      this.action.resetCapabilities();
      this.reconnectAttempt = 0;
      this.lastPongAt = Date.now();
      this.log.info({ url }, '✅ 已连接 OneBot');
      this.startHeartbeat();
      void this.onConnected(generation);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      if (!current()) return;
      this.handleRawMessage(data);
    });

    ws.on('error', (err: Error) => {
      if (!current()) return;
      this.log.warn({ err: err.message }, 'OneBot WebSocket 错误');
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (!current()) return;
      this.ws = null;
      this.accountReady = false;
      this.apiReady = false;
      this.rejectPending('连接断开，动作结果未知');
      const reasonStr = reason?.toString?.() || '';
      this.connected = false;
      this.clearTimers();
      this.emit('disconnected', { code, reason: reasonStr });
      if (this.closedByUser) {
        this.log.info('OneBot 连接已关闭（主动）');
        return;
      }
      this.log.warn({ code, reason: reasonStr }, 'OneBot 连接断开');
      this.scheduleReconnect();
    });
  }

  private async onConnected(generation: number): Promise<void> {
    try {
      const info = await this.action.getLoginInfo({ timeoutMs: 10000, throwOnError: true });
      if (generation !== this.generation || !this.connected) return;
      this.selfId = Number(info.user_id) || this.cfg.selfId || 0;
      this.nickname = info.nickname || '';
      this.accountReady = this.selfId > 0;
      this.apiReady = true;
      try {
        const version = await this.action.getVersionInfo({ timeoutMs: 2000, throwOnError: true });
        if (generation !== this.generation || !this.connected) return;
        this.implementation = { name: version.app_name || '', version: version.app_version || '', protocol: version.protocol_version || '' };
      } catch { /* 实现不支持查询时保留未知名称 */ }
      if (generation !== this.generation || !this.connected) return;
      this.log.info({ selfId: this.selfId, nickname: this.nickname }, '🤖 机器人账号已就绪');
      this.emit('ready', { selfId: this.selfId, nickname: this.nickname });
    } catch (e) {
      if (generation !== this.generation || !this.connected) return;
      // 拿不到 login_info 不算致命：某些实现可能不支持，退回配置值
      this.selfId = this.cfg.selfId;
      this.accountReady = this.selfId > 0;
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
    const delay = Math.min(initialMs * Math.pow(factor, this.reconnectAttempt), maxMs) * (0.8 + Math.random() * 0.2);
    this.reconnectAttempt++;
    this.emit('reconnecting', { attempt: this.reconnectAttempt, delayMs: Math.round(delay) });
    this.log.info(
      { attempt: this.reconnectAttempt, delayMs: Math.round(delay) },
      `${(delay / 1000).toFixed(1)}s 后重连 OneBot`,
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
    const generation = this.generation;

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
      void this.action.getStatus({ timeoutMs, throwOnError: true }).then(() => { if (generation === this.generation) this.apiReady = true; })
        .catch(() => { if (generation === this.generation) this.apiReady = false; });
    }, intervalMs);
  }

  // ==================== 收发 ====================

  private async rawSend(payload: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount + Buffer.byteLength(payload) > this.cfg.maxBufferedBytes) return false;
    const ws = this.ws;
    return new Promise((resolve, reject) => {
      try { ws.send(payload, (e) => e ? reject(new OneBotActionError('transport', 'failed', -1, e.message, 'unknown')) : resolve(true)); }
      catch { resolve(false); }
    });
  }

  private cancelPending(echo: string): void {
    const p = this.pending.get(echo);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(echo);
    p.reject(new Error('等待器已取消'));
  }

  private rejectPending(reason: string): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  private waitForResponse(echo: string, timeoutMs: number): Promise<OneBotResponse> {
    if (this.pending.size >= this.cfg.maxPending) throw new OneBotActionError('transport', 'failed', -1, 'pending 已达到上限');
    return new Promise<OneBotResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`等待 ${echo} 响应超时`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer, generation: this.generation });
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

    // 可能是单个对象，也可能是数组（OneBot 某些配置下批量上报）
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
      if (p && p.generation === this.generation) {
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
        this.log.trace('收到 OneBot 心跳');
      } else if (metaType === 'lifecycle') {
        this.log.info({ sub: obj['sub_type'] }, 'OneBot 生命周期事件');
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


