/**
 * 触发策略
 *
 * 决定「这条消息要不要回复」，避免机器人在群里刷屏。
 * 同时实现冷却与并发限制。
 */
import type { Logger } from '../core/logger.js';
import type { AppConfig, InboundMessage } from '../core/types.js';

export type TriggerDecision =
  | { reply: true; reason: string; /** 清洗后用于生成的消息文本 */ text: string; direct: boolean }
  | { reply: false; reason: string };

export interface CooldownState {
  lastReplyAt: number;
  inFlight: number;
}

export class TriggerPolicy {
  /** scope -> 冷却/并发状态 */
  private state = new Map<string, CooldownState>();

  constructor(
    private readonly cfg: AppConfig['trigger'],
    private readonly log: Logger,
  ) {}

  private getState(scope: string): CooldownState {
    let s = this.state.get(scope);
    if (!s) {
      s = { lastReplyAt: 0, inFlight: 0 };
      this.state.set(scope, s);
    }
    return s;
  }

  /** 标记一次生成开始 */
  beginGenerating(scope: string): void {
    this.getState(scope).inFlight++;
  }

  /** 标记一次生成结束（成功回复时更新冷却时间） */
  endGenerating(scope: string, replied: boolean): void {
    const s = this.getState(scope);
    s.inFlight = Math.max(0, s.inFlight - 1);
    if (replied) s.lastReplyAt = Date.now();
  }

  /** 该会话当前是否在冷却中 */
  isCoolingDown(scope: string): boolean {
    const s = this.getState(scope);
    return Date.now() - s.lastReplyAt < this.cfg.group.cooldownMs;
  }

  /** 当前并发生成数 */
  inFlight(scope: string): number {
    return this.getState(scope).inFlight;
  }

  /**
   * 用户级准入检查：黑名单优先，白名单非空时才生效。
   *
   * 独立成方法是为了让「命令」路径也能复用同一套判定 ——
   * 命令是在管线之前处理的，如果只在这里拦住普通消息，
   * 被拉黑的人仍然可以用 /forget、/persona 等命令操作。
   */
  checkUser(userId: number): { allowed: boolean; reason?: string } {
    if (this.cfg.denyUsers.includes(userId)) {
      return { allowed: false, reason: '用户在黑名单中' };
    }
    if (this.cfg.allowUsers.length > 0 && !this.cfg.allowUsers.includes(userId)) {
      return { allowed: false, reason: '用户不在白名单中' };
    }
    return { allowed: true };
  }

  /** 群级准入检查（群白名单非空时生效） */
  checkGroup(groupId: number | undefined): { allowed: boolean; reason?: string } {
    const list = this.cfg.group.enabledGroups;
    if (list.length === 0) return { allowed: true };
    if (groupId === undefined) return { allowed: false, reason: '非群聊且配置了群白名单' };
    if (!list.includes(groupId)) return { allowed: false, reason: '群不在白名单中' };
    return { allowed: true };
  }

  /** 是否管理员 */
  isAdmin(userId: number): boolean {
    return this.cfg.admins.includes(userId);
  }

  /** 是否允许使用命令 */
  canUseCommands(userId: number): { allowed: boolean; reason?: string } {
    if (!this.cfg.commandAdminOnly) return { allowed: true };
    if (this.isAdmin(userId)) return { allowed: true };
    return { allowed: false, reason: '命令仅限管理员使用' };
  }

  /** 是否允许通过命令切换人格（查看人格信息不受此限制） */
  canSwitchPersona(userId: number): { allowed: boolean; reason?: string } {
    // 命令本身被限制时，这条也一并受限
    const cmd = this.canUseCommands(userId);
    if (!cmd.allowed) return cmd;
    if (!this.cfg.personaAdminOnly) return { allowed: true };
    if (this.isAdmin(userId)) return { allowed: true };
    return { allowed: false, reason: '只有管理员可以切换人格' };
  }

  /**
   * 判断是否应该回复
   */
  decide(msg: InboundMessage, selfId: number): TriggerDecision {
    // ---- 黑白名单 ----
    const gate = this.checkUser(msg.userId);
    if (!gate.allowed) {
      return { reply: false, reason: gate.reason ?? '用户不被允许' };
    }
    // ---- 群白名单 ----
    if (msg.scopeType === 'group') {
      const g = this.checkGroup(msg.groupId);
      if (!g.allowed) return { reply: false, reason: g.reason ?? '群不被允许' };
    }
    // ---- 自己发的消息 ----
    if (this.cfg.group.ignoreSelf && msg.userId === selfId) {
      return { reply: false, reason: '是机器人自己发的消息' };
    }
    // ---- 空消息 ----
    const text = msg.text.trim();
    if (!text && msg.segments.every((s) => s.type !== 'image' && s.type !== 'record')) {
      return { reply: false, reason: '消息内容为空' };
    }

    if (msg.scopeType === 'private') {
      return this.decidePrivate(msg, text);
    }
    return this.decideGroup(msg, text);
  }

  private decidePrivate(msg: InboundMessage, text: string): TriggerDecision {
    const mode = this.cfg.private;
    if (mode === 'always') {
      return { reply: true, reason: '私聊默认回复', text, direct: true };
    }
    if (mode === 'keyword') {
      const hit = this.cfg.privateKeywords.some((k) => k && text.includes(k));
      return hit
        ? { reply: true, reason: '私聊命中关键词', text, direct: true }
        : { reply: false, reason: '私聊未命中关键词' };
    }
    // prefix
    const hit = this.cfg.privateKeywords.some((k) => k && text.startsWith(k));
    return hit
      ? { reply: true, reason: '私聊命中前缀', text, direct: true }
      : { reply: false, reason: '私聊未命中前缀' };
  }

  private decideGroup(msg: InboundMessage, text: string): TriggerDecision {
    const g = this.cfg.group;

    // 群白名单（非空时生效）
    if (g.enabledGroups.length > 0 && msg.groupId !== undefined && !g.enabledGroups.includes(msg.groupId)) {
      return { reply: false, reason: '群不在白名单中' };
    }

    // 冷却中的话，只记录不回复
    if (this.isCoolingDown(msg.scope)) {
      return { reply: false, reason: '会话冷却中' };
    }
    if (this.inFlight(msg.scope) >= g.maxConcurrent) {
      return { reply: false, reason: '该会话并发生成已达上限' };
    }

    // @机器人 一定回复
    if (msg.mentionsBot) {
      return { reply: true, reason: '@了机器人', text: stripMention(text), direct: true };
    }

    // 关键词触发
    const kw = g.keywords.find((k) => k && text.includes(k));
    if (kw) {
      return { reply: true, reason: `命中关键词「${kw}」`, text, direct: false };
    }

    // 前缀触发
    const pf = g.prefixes.find((p) => p && text.startsWith(p));
    if (pf) {
      return { reply: true, reason: `命中前缀「${pf}」`, text: text.slice(pf.length).trim(), direct: false };
    }

    return { reply: false, reason: '群聊未@机器人且未命中触发词' };
  }
}

/** 去掉文本里的 @机器人 痕迹，避免把 "@你" 喂给模型 */
export function stripMention(text: string): string {
  return text
    .replace(/@你\s*/g, '')
    .replace(/^@\S+\s+/g, '')
    .trim();
}

/** 解析 quietHours 形如 "23:00-08:00"，判断当前是否在免打扰时段 */
export function isQuietHour(ranges: string[], date = new Date()): boolean {
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const range of ranges) {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range.trim());
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    if (start <= end) {
      if (minutes >= start && minutes < end) return true;
    } else {
      // 跨午夜，如 23:00-08:00
      if (minutes >= start || minutes < end) return true;
    }
  }
  return false;
}
