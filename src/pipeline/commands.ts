/**
 * 内置命令
 *
 * 让用户能在 QQ 里直接控制和查看 Agent：
 *   /help              帮助
 *   /persona [id]      查看或切换当前会话人格
 *   /personas          列出所有可用人格
 *   /memory            查看我记住了关于你的什么
 *   /forget <关键词>   删除某条记忆
 *   /emotion           查看当前情绪状态
 *   /stats             查看统计
 */
import type { Logger } from '../core/logger.js';
import type { AppConfig } from '../core/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { PersonaManager } from '../persona/manager.js';
import { EMOTION_LABELS_CN } from '../emotion/analyzer.js';
import { FACT_TYPE_CN } from '../memory/extractor.js';

export interface CommandContext {
  scope: string;
  scopeType: 'private' | 'group';
  userId: number;
  senderName: string;
  arg: string;
  /** 该用户是否管理员（由 TriggerPolicy 判定后传入） */
  isAdmin: boolean;
  /** 是否允许使用命令 */
  canUseCommands: boolean;
  /** 是否允许切换人格 */
  canSwitchPersona: boolean;
  /** 不允许时的原因，用于给出友好提示 */
  denyReason?: string;
}

export interface CommandResult {
  handled: boolean;
  reply?: string;
}

export class CommandHandler {
  constructor(
    private readonly cfg: AppConfig,
    private readonly store: MemoryStore,
    private readonly personas: PersonaManager,
    private readonly log: Logger,
  ) {}

  /**
   * 尝试把消息当作命令处理
   */
  async tryHandle(text: string, ctx: Omit<CommandContext, 'arg'>): Promise<CommandResult> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return { handled: false };

    const sp = trimmed.indexOf(' ');
    const cmd = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
    const arg = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
    const full: CommandContext = { ...ctx, arg };

    // ---- 管理员门禁 ----
    // 这两项由 TriggerPolicy 判定后传入，这里不再自己读配置，避免两处判定不一致。
    const personaCmd = cmd === '/persona' || cmd === '/人格';
    if (personaCmd && !ctx.canSwitchPersona) {
      return {
        handled: true,
        reply: `没有权限切换人格：${ctx.denyReason ?? '仅限管理员'}。`,
      };
    }
    if (!personaCmd && !ctx.canUseCommands) {
      return {
        handled: true,
        reply: `没有权限使用命令：${ctx.denyReason ?? '仅限管理员'}。`,
      };
    }

    switch (cmd) {
      case '/help':
      case '/?':
        return { handled: true, reply: this.help() };
      case '/persona':
      case '/人格':
        return { handled: true, reply: this.handlePersona(full) };
      case '/personas':
      case '/人格列表':
        return { handled: true, reply: this.listPersonas() };
      case '/memory':
      case '/记忆':
        return { handled: true, reply: this.showMemory(full) };
      case '/forget':
      case '/忘记':
        return { handled: true, reply: this.forget(full) };
      case '/emotion':
      case '/情绪':
        return { handled: true, reply: this.showEmotion(full) };
      case '/new':
      case '/新话题':
        return { handled: true, reply: this.newTopic(full) };
      case '/topics':
      case '/话题':
        return { handled: true, reply: this.listTopics(full) };
      case '/stats':
      case '/统计':
        return { handled: true, reply: this.stats() };
      case '/reset':
        // 交给上层处理（需要 API 访问权限）
        return { handled: false };
      default:
        return { handled: false };
    }
  }

  private help(): string {
    const p = this.cfg.persona.commandPrefix;
    return [
      '🐱 可用命令：',
      `${p} <人格id> — 切换当前会话的人格`,
      `${p}s — 列出所有人格`,
      '/memory — 查看我记得关于你的什么',
      '/forget <关键词> — 让我忘掉某条记忆',
      '/emotion — 查看你当前的情绪状态',
      '/new [标题] — 开一个新话题（旧话题保留）',
      '/topics — 查看/切换本会话的话题',
      '/stats — 查看统计信息',
      '/help — 显示这条帮助',
    ].join('\n');
  }

  private handlePersona(ctx: CommandContext): string {
    if (!this.cfg.persona.commandEnabled) {
      return '（人格切换功能已关闭）';
    }

    // 查看当前人格
    if (!ctx.arg) {
      const { persona, source } = this.personas.resolve(ctx.scope, ctx.userId);
      const sourceLabel: Record<string, string> = {
        session: '本会话设置',
        user: '你的个人设置',
        'config-scope': '配置文件指定',
        default: '默认人格',
      };
      return [
        `当前人格：${persona.emoji} ${persona.name}`,
        `${persona.description}`,
        `（来源：${sourceLabel[source] ?? source}）`,
        '',
        `用 ${this.cfg.persona.commandPrefix} <人格id> 切换，或发 ${this.cfg.persona.commandPrefix}s 看全部。`,
      ].join('\n');
    }

    const target = ctx.arg.toLowerCase().replace(/^@/, '');
    if (!this.personas.has(target)) {
      const ids = this.personas.list().map((x) => x.id).join(', ');
      return `没有叫「${target}」的人格。\n可用：${ids}`;
    }

    const ok = this.personas.setForSession(ctx.scope, target);
    if (!ok) return '切换失败。';

    const persona = this.personas.get(target)!;
    return `人格已切换为 ${persona.emoji} ${persona.name}\n${persona.description}`;
  }

  private listPersonas(): string {
    const list = this.personas.list();
    const current = this.personas.resolve('', 0);
    const lines = ['🎭 可用人格：'];
    for (const p of list) {
      const mark = p.id === current.persona.id ? ' ← 当前默认' : '';
      lines.push(`${p.emoji} ${p.id} — ${p.name}：${p.description}${mark}`);
    }
    lines.push('');
    lines.push(`用 ${this.cfg.persona.commandPrefix} <id> 切换`);
    return lines.join('\n');
  }

  private showMemory(ctx: CommandContext): string {
    const user = this.store.getUser(ctx.userId);
    const facts = this.store.getFactsByUser(ctx.userId, {
      scope: ctx.scope,
      shareableOnly: this.cfg.memory.retrieval.crossScopeSharing === 'identity-facts',
      limit: 30,
    });
    if (facts.length === 0) {
      return '我还没有记住关于你的具体事情。多聊聊，我会慢慢记住的～';
    }

    const lines = [`🧠 关于你（${user?.nickname || ctx.userId}）我记得：`];
    const byType = new Map<string, string[]>();
    for (const f of facts) {
      const list = byType.get(f.fact_type) ?? [];
      list.push(f.content);
      byType.set(f.fact_type, list);
    }
    for (const [type, items] of byType) {
      lines.push('');
      lines.push(`【${FACT_TYPE_CN[type] ?? type}】`);
      for (const it of items.slice(0, 8)) lines.push(`· ${it}`);
    }

    const stats = this.store.stats();
    lines.push('');
    lines.push(`（共 ${facts.length} 条关于你的记忆，总计 ${stats.facts} 条）`);
    lines.push('想删掉某条？发 /forget <关键词>');
    return lines.join('\n');
  }

  private forget(ctx: CommandContext): string {
    if (!ctx.arg) return '用法：/forget <关键词>\n例如：/forget 可乐';
    const kw = ctx.arg;
    const facts = this.store.getFactsByUser(ctx.userId, { limit: 500 });
    const matched = facts.filter((f) => f.content.includes(kw) || f.keywords.includes(kw));
    if (matched.length === 0) return `没找到包含「${kw}」的记忆。`;
    for (const f of matched) this.store.deleteFact(f.id);
    this.log.info({ userId: ctx.userId, keyword: kw, deleted: matched.length }, '用户删除记忆');
    return `已忘掉 ${matched.length} 条关于「${kw}」的记忆：\n${matched.map((f) => `· ${f.content}`).join('\n')}`;
  }

  /**
   * /new [标题] —— 开一个新话题。
   * 旧话题不会丢，只是从此不再进入上下文；可用 /topics 切回。
   */
  private newTopic(ctx: CommandContext): string {
    const title = ctx.arg?.trim() || '';
    const id = this.store.newConversation(ctx.scope, title);
    const conv = this.store.getConversation(id);
    return [
      `已开新话题：${conv?.title ?? '新话题'}`,
      '（之前的话题都保留了，发 /topics 可以切回去）',
      '这一条之后说的内容都会算在新话题里。',
    ].join('\n');
  }

  /** /topics —— 列出本会话的话题，可带序号切换 */
  private listTopics(ctx: CommandContext): string {
    const list = this.store.listConversations(ctx.scope, { includeArchived: true });
    if (list.length === 0) return '还没有任何话题。';

    const current = this.store.currentConversationId(ctx.scope);
    const lines = [`💬 本会话共有 ${list.length} 个话题：`, ''];
    list.forEach((c, i) => {
      const mark = c.id === current ? ' ← 当前' : '';
      const when = new Date(c.last_active).toLocaleDateString('zh-CN');
      const tokens = c.token_usage > 0 ? ` ｜ ${c.token_usage} tokens` : '';
      const arch = c.archived ? '（已归档）' : '';
      lines.push(`${i + 1}. ${c.title || '未命名'}${arch} ｜ ${c.message_count} 条 ｜ ${when}${tokens}${mark}`);
    });
    lines.push('');
    lines.push('发 /topics <序号> 切换，或 /new <标题> 开新话题。');

    // 带参数就切换
    const idx = Number(ctx.arg?.trim());
    if (Number.isFinite(idx) && idx >= 1 && idx <= list.length) {
      const target = list[idx - 1]!;
      const ok = this.store.switchConversation(ctx.scope, target.id);
      return (
        (ok ? `已切到话题：${target.title || '未命名'}\n\n` : '切换失败。\n\n') +
        lines.join('\n')
      );
    }
    if (ctx.arg?.trim()) {
      lines.unshift(`没有第 ${ctx.arg.trim()} 个话题。`, '');
    }
    return lines.join('\n');
  }

  private showEmotion(ctx: CommandContext): string {    const state = this.store.getEmotionState(ctx.userId, ctx.scope);
    if (!state) return '我还没分析出你的情绪状态。多聊几句吧～';
    const label = EMOTION_LABELS_CN[state.label] ?? state.label;
    const bar = (v: number, lo: number, hi: number) => {
      const n = Math.round(((v - lo) / (hi - lo)) * 10);
      return '█'.repeat(Math.max(0, Math.min(10, n))) + '░'.repeat(10 - Math.max(0, Math.min(10, n)));
    };
    return [
      `📊 你当前的情绪状态：${label}`,
      '',
      `效价(好坏) ${bar(state.valence, -1, 1)} ${state.valence.toFixed(2)}`,
      `唤醒(激动) ${bar(state.arousal, 0, 1)} ${state.arousal.toFixed(2)}`,
      `支配(掌控) ${bar(state.dominance, 0, 1)} ${state.dominance.toFixed(2)}`,
      `强度      ${bar(state.intensity, 0, 1)} ${state.intensity.toFixed(2)}`,
      '',
      `（基于最近 ${state.samples} 次分析，置信度 ${(state.confidence * 100).toFixed(0)}%）`,
    ].join('\n');
  }

  private stats(): string {
    const s = this.store.stats();
    const usage = this.store.stats();
    void usage;
    return [
      '📈 统计信息：',
      `用户 ${s.users} 人`,
      `会话 ${s.sessions} 个`,
      `消息 ${s.messages} 条`,
      `长期记忆 ${s.facts} 条`,
      `摘要 ${s.summaries} 条`,
      `情绪记录 ${s.emotionRecords} 条`,
    ].join('\n');
  }
}
