/**
 * 记忆存储层
 *
 * 直接封装 SQLite 操作，是记忆系统的唯一数据出入口。
 * 所有方法都是同步的（node:sqlite 是同步 API），性能足够 QQ 场景。
 */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initDatabase, newConversationId } from './schema.js';
import type { EmotionScore } from '../core/types.js';
import { blobToVector, cosineSimilarity, vectorToBlob } from '../llm/embedding.js';

export interface UserRow {
  user_id: number;
  nickname: string;
  aliases: string;
  first_seen: number;
  last_seen: number;
  message_count: number;
  persona_id: string | null;
  notes: string;
}

export interface SessionRow {
  scope: string;
  scope_type: string;
  target_id: number;
  persona_id: string | null;
  title: string;
  first_seen: number;
  last_active: number;
  message_count: number;
  summary_level: number;
  /** 当前激活的对话 id（多话题） */
  current_conversation_id: string | null;
}

/** 一个会话下的一条话题线 */
export interface ConversationRow {
  id: string;
  scope: string;
  title: string;
  persona_id: string | null;
  token_usage: number;
  archived: number;
  first_seen: number;
  last_active: number;
  message_count: number;
}

export interface MessageRow {
  persona_id?: string | null;
  persona_fingerprint?: string | null;
  conversation_id?: string | null;
  id: number;
  scope: string;
  user_id: number;
  role: string;
  content: string;
  raw_segments: string | null;
  message_id: number | null;
  sender_name: string;
  tokens: number;
  emotion_label: string | null;
  emotion_valence: number | null;
  emotion_arousal: number | null;
  emotion_dominance: number | null;
  emotion_intensity: number | null;
  summarized: number;
  created_at: number;
}

export interface FactRow {
  private: number;
  active: number;
  replaces_id: number | null;
  id: number;
  user_id: number;
  scope: string;
  fact_type: string;
  content: string;
  keywords: string;
  confidence: number;
  shareable: number;
  source_msg_id: number | null;
  hit_count: number;
  last_hit_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SummaryRow {
  id: number;
  scope: string;
  level: number;
  content: string;
  msg_from_id: number | null;
  msg_to_id: number | null;
  msg_count: number;
  tokens: number;
  created_at: number;
}

export interface EmotionStateRow {
  user_id: number;
  scope: string;
  label: string;
  valence: number;
  arousal: number;
  dominance: number;
  intensity: number;
  confidence: number;
  samples: number;
  updated_at: number;
}

export interface AddMessageInput {
  personaId?: string;
  personaFingerprint?: string;
  conversationId?: string;
  scope: string;
  userId: number;
  role: 'user' | 'assistant';
  content: string;
  rawSegments?: string;
  messageId?: number;
  senderName?: string;
  tokens?: number;
  emotion?: EmotionScore;
  createdAt?: number;
}

export interface FactInput {
  userId: number;
  scope: string;
  factType: string;
  content: string;
  keywords?: string;
  confidence?: number;
  shareable?: boolean;
  sourceMsgId?: number;
  replacesId?: number;
}

/** 粗略估算 token 数（中文约 1.5 字/token，英文约 4 字符/token） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.5 + rest / 3.5));
}

export class MemoryStore {
  readonly db: DatabaseSync;
  /** scope -> 当前对话 id 缓存（避免热路径反复查库） */
  private convCache = new Map<string, string>();
  private conversationListeners = new Set<(scope: string, conversationId: string) => void>();
  onConversationChange(listener: (scope: string, conversationId: string) => void): () => void {
    this.conversationListeners.add(listener);
    return () => this.conversationListeners.delete(listener);
  }
  private conversationChanged(scope: string, id: string): void {
    for (const listener of this.conversationListeners) listener(scope, id);
  }
  private resolveConversation(scope: string, id?: string): string {
    if (!id) return this.currentConversationId(scope);
    if (this.getConversation(id)?.scope !== scope) throw new Error('指定话题不存在或不属于该会话');
    return id;
  }

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = initDatabase(dbPath);
  }

  close(): void {
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.conversationListeners.clear();
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  // ==================== 用户 ====================

  private closeListeners = new Set<() => void>();
  onClose(listener: () => void): void { this.closeListeners.add(listener); }

  /** 确保用户存在并更新活跃信息；返回用户行 */
  touchUser(userId: number, nickname: string, now = Date.now()): UserRow {
    const existing = this.getUser(userId);
    if (!existing) {
      this.db
        .prepare(
          'INSERT INTO users(user_id, nickname, aliases, first_seen, last_seen, message_count) VALUES (?,?,?,?,?,0)',
        )
        .run(userId, nickname, JSON.stringify(nickname ? [nickname] : []), now, now);
      return this.getUser(userId)!;
    }

    // 昵称变化时记入别名历史
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(existing.aliases) as string[];
    } catch {
      aliases = [];
    }
    let nicknameChanged = false;
    if (nickname && nickname !== existing.nickname && !aliases.includes(nickname)) {
      aliases.push(nickname);
      // 只保留最近 20 个别名
      if (aliases.length > 20) aliases = aliases.slice(-20);
      nicknameChanged = true;
    }

    this.db
      .prepare('UPDATE users SET last_seen = ?, nickname = ?, aliases = ? WHERE user_id = ?')
      .run(
        now,
        nickname || existing.nickname,
        nicknameChanged ? JSON.stringify(aliases) : existing.aliases,
        userId,
      );
    return this.getUser(userId)!;
  }

  getUser(userId: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as UserRow | undefined;
  }

  listUsers(limit = 200): UserRow[] {
    return this.db
      .prepare('SELECT * FROM users ORDER BY last_seen DESC LIMIT ?')
      .all(limit) as unknown as UserRow[];
  }

  /** 设置用户私聊人格 */
  setUserPersona(userId: number, personaId: string | null): void {
    this.db.prepare('UPDATE users SET persona_id = ? WHERE user_id = ?').run(personaId, userId);
  }

  // ==================== 会话 ====================

  touchSession(
    scope: string,
    scopeType: 'private' | 'group',
    targetId: number,
    title = '',
    now = Date.now(),
  ): SessionRow {
    const existing = this.getSession(scope);
    if (!existing) {
      this.db
        .prepare(
          'INSERT INTO sessions(scope, scope_type, target_id, title, first_seen, last_active, message_count) VALUES (?,?,?,?,?,?,0)',
        )
        .run(scope, scopeType, targetId, title, now, now);
    } else {
      this.db
        .prepare('UPDATE sessions SET last_active = ?, title = ? WHERE scope = ?')
        .run(now, title || existing.title, scope);
    }
    return this.getSession(scope)!;
  }

  getSession(scope: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE scope = ?').get(scope) as SessionRow | undefined;
  }

  // ==================== 对话（一个会话下的多个话题） ====================
  // 参考 AstrBot 的 session / conversation 分离：
  //   会话 = 私聊或某个群；对话 = 窗口里的一条话题线，可新建/切换/删除。
  // 人格与 token 用量挂在对话上。

  /**
   * 取某会话「当前激活」的对话 id；没有就建一个默认对话。
   * 内部带缓存，热路径不会每次都查库。
   */
  currentConversationId(scope: string): string {
    const cached = this.convCache.get(scope);
    if (cached && this.getConversation(cached)) return cached;

    const row = this.getSession(scope);
    const cur = row?.current_conversation_id;
    if (cur && this.getConversation(cur)) {
      this.convCache.set(scope, cur);
      return cur;
    }

    // 会话还没建 or 当前对话失效：复用最近一个，否则新建
    const latest = this.db
      .prepare('SELECT id FROM conversations WHERE scope = ? ORDER BY last_active DESC LIMIT 1')
      .get(scope) as { id: string } | undefined;

    let id = latest?.id;
    if (!id) {
      id = newConversationId();
      const now = Date.now();
      const title = row?.title || (row?.scope_type === 'group' ? `群${row.target_id}` : '默认话题');
      // persona_id 留 NULL：对话默认继承会话/全局人格，只有显式设置才覆盖
      this.db
        .prepare(
          `INSERT INTO conversations(id, scope, title, persona_id, token_usage, archived, first_seen, last_active, message_count)
           VALUES (?, ?, ?, NULL, 0, 0, ?, ?, 0)`,
        )
        .run(id, scope, title, now, now);
    }

    this.db.prepare('UPDATE sessions SET current_conversation_id = ? WHERE scope = ?').run(id, scope);
    this.convCache.set(scope, id);
    return id;
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
  }

  /** 列出某会话下的对话（默认不含归档） */
  listConversations(scope: string, opts: { includeArchived?: boolean; limit?: number } = {}): ConversationRow[] {
    const limit = opts.limit ?? 50;
    const sql = opts.includeArchived
      ? 'SELECT * FROM conversations WHERE scope = ? ORDER BY last_active DESC LIMIT ?'
      : 'SELECT * FROM conversations WHERE scope = ? AND archived = 0 ORDER BY last_active DESC LIMIT ?';
    return this.db.prepare(sql).all(scope, limit) as unknown as ConversationRow[];
  }

  /** 新建一个对话并切过去 */
  newConversation(scope: string, title = '', personaId: string | null = null): string {
    const id = newConversationId();
    const now = Date.now();
    const sess = this.getSession(scope);
    const fallbackTitle = sess?.scope_type === 'group' ? `群${sess.target_id} 新话题` : '新话题';
    // 不传 personaId 时留 NULL（继承），而不是抄会话人格 —— 否则会话级切换会失效
    this.db
      .prepare(
        `INSERT INTO conversations(id, scope, title, persona_id, token_usage, archived, first_seen, last_active, message_count)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, 0)`,
      )
      .run(id, scope, title || fallbackTitle, personaId, now, now);
    this.db.prepare('UPDATE sessions SET current_conversation_id = ? WHERE scope = ?').run(id, scope);
    this.convCache.set(scope, id);
    this.conversationChanged(scope, id);
    return id;
  }

  /** 切换人格和话题指针在同一事务提交，提交后才取消旧任务。 */
  switchSessionPersona(scope:string,personaId:string,history:'keep'|'new',previousPersonaId:string):string {
    const oldId=this.currentConversationId(scope);
    let id=oldId;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.setSessionPersona(scope,personaId);
      if(history==='new') {
        this.db.prepare('UPDATE conversations SET persona_id=COALESCE(persona_id,?) WHERE id=?').run(previousPersonaId,oldId);
        id=newConversationId(); const now=Date.now();
        this.db.prepare('INSERT INTO conversations(id,scope,title,persona_id,token_usage,archived,first_seen,last_active,message_count) VALUES(?,?,?,?,0,0,?,?,0)').run(id,scope,'人格 '+personaId+' 新话题',personaId,now,now);
        this.db.prepare('UPDATE sessions SET current_conversation_id=? WHERE scope=?').run(id,scope);
      } else this.db.prepare('UPDATE conversations SET persona_id=? WHERE id=?').run(personaId,id);
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
    this.convCache.set(scope,id); this.conversationChanged(scope,id);
    return id;
  }

  /** 切到指定对话 */
  switchConversation(scope: string, conversationId: string): boolean {
    const conv = this.getConversation(conversationId);
    if (!conv || conv.scope !== scope) return false;
    const oldId = this.currentConversationId(scope);
    this.db.prepare('UPDATE sessions SET current_conversation_id = ? WHERE scope = ?').run(conversationId, scope);
    this.convCache.set(scope, conversationId);
    if (oldId !== conversationId) this.conversationChanged(scope, conversationId);
    return true;
  }

  renameConversation(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
  }

  /** 归档对话（保留数据，只是不再出现在默认列表里） */
  archiveConversation(id: string, archived = true): void {
    this.db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  }

  /** 删除对话及其消息（会连带清掉该对话的摘要） */
  deleteConversation(id: string): void {
    const conv = this.getConversation(id);
    if (!conv) return;
    this.conversationChanged(conv.scope, id);
    this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    this.db.prepare('DELETE FROM summaries WHERE conversation_id = ?').run(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    if (this.convCache.get(conv.scope) === id) this.convCache.delete(conv.scope);
  }

  /** 累加某对话的 token 用量 */
  addConversationTokens(id: string, tokens: number): void {
    if (tokens <= 0) return;
    this.db.prepare('UPDATE conversations SET token_usage = token_usage + ? WHERE id = ?').run(tokens, id);
  }

  /** 给对话改人格（覆盖会话与默认） */
  setConversationPersona(id: string, personaId: string | null): void {
    this.db.prepare('UPDATE conversations SET persona_id = ? WHERE id = ?').run(personaId, id);
  }

  /** 统计某会话的对话数量 */
  countConversations(scope: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE scope = ?').get(scope) as { n: number }).n;
  }

  listSessions(limit = 200): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY last_active DESC LIMIT ?')
      .all(limit) as unknown as SessionRow[];
  }

  /**
   * 设置会话人格。
   * 用 UPSERT：会话可能还没被创建（例如在收到第一条消息前就切换人格），
   * 纯 UPDATE 会静默失败，导致设置丢失。
   */
  setSessionPersona(scope: string, personaId: string | null): void {
    const existing = this.getSession(scope);
    if (!existing) {
      const [type, idStr] = scope.split(':');
      const targetId = Number(idStr);
      if (!Number.isFinite(targetId)) {
        this.log_skip(`非法 scope: ${scope}`);
        return;
      }
      const now = Date.now();
      this.db
        .prepare(
          'INSERT INTO sessions(scope, scope_type, target_id, title, persona_id, first_seen, last_active, message_count) VALUES (?,?,?,?,?,?,?,0)',
        )
        .run(scope, type === 'group' ? 'group' : 'private', targetId, '', personaId, now, now);
      return;
    }
    this.db.prepare('UPDATE sessions SET persona_id = ? WHERE scope = ?').run(personaId, scope);
  }

  /** 内部：非法参数时静默（避免记忆层抛异常影响主流程） */
  private log_skip(_msg: string): void {
    /* 故意留空：非法 scope 不应中断流程 */
  }

  // ==================== 消息 ====================

  beginDelivery(scope: string, conversationId = this.currentConversationId(scope)): number {
    const now = Date.now();
    return Number(this.db.prepare('INSERT INTO reply_deliveries(scope, conversation_id, state, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(scope, conversationId, 'pending', now, now).lastInsertRowid);
  }

  finishDelivery(id: number, state: string, pieces: unknown[]): void {
    this.db.prepare('UPDATE reply_deliveries SET state = ?, pieces = ?, updated_at = ? WHERE id = ?')
      .run(state, JSON.stringify(pieces), Date.now(), id);
  }

  addMessage(input: AddMessageInput): number {
    const now = input.createdAt ?? Date.now();
    const tokens = input.tokens ?? estimateTokens(input.content);
    const e = input.emotion;
    // 消息归属到「当前对话」，这样开新话题后历史不会串
    const convId = this.resolveConversation(input.scope, input.conversationId);

    const info = this.db
      .prepare(
        `INSERT INTO messages(
           scope, conversation_id, user_id, role, content, raw_segments, message_id, sender_name, tokens,
           emotion_label, emotion_valence, emotion_arousal, emotion_dominance, emotion_intensity,
           summarized, created_at, persona_id, persona_fingerprint
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      )
      .run(
        input.scope,
        convId,
        input.userId,
        input.role,
        input.content,
        input.rawSegments ?? null,
        input.messageId ?? null,
        input.senderName ?? '',
        tokens,
        e?.label ?? null,
        e?.valence ?? null,
        e?.arousal ?? null,
        e?.dominance ?? null,
        e?.intensity ?? null,
        now,
        input.role === 'assistant' ? input.personaId ?? null : null,
        input.role === 'assistant' ? input.personaFingerprint ?? null : null,
      );

    // 更新计数
    this.db.prepare('UPDATE sessions SET message_count = message_count + 1, last_active = ? WHERE scope = ?').run(now, input.scope);
    this.db
      .prepare('UPDATE conversations SET message_count = message_count + 1, last_active = ? WHERE id = ?')
      .run(now, convId);
    if (input.role === 'user') {
      this.db.prepare('UPDATE users SET message_count = message_count + 1, last_seen = ? WHERE user_id = ?').run(now, input.userId);
    }

    return Number(info.lastInsertRowid);
  }

  /**
   * 取某会话「当前对话」最近 N 条消息（时间正序，便于直接拼 prompt）。
   * 注意：这里按对话过滤，而不是按 scope —— 这正是多话题隔离的关键。
   * 老数据（conversation_id 为空）在迁移时已回填，不会漏。
   */
  getRecentMessages(scope: string, limit: number, excludeSummarized = false, conversationId?: string, cutoffId = Number.MAX_SAFE_INTEGER): MessageRow[] {
    const convId = this.resolveConversation(scope, conversationId);
    const sql = excludeSummarized
      ? 'SELECT * FROM messages WHERE conversation_id = ? AND id <= ? AND summarized = 0 ORDER BY created_at DESC, id DESC LIMIT ?'
      : 'SELECT * FROM messages WHERE conversation_id = ? AND id <= ? ORDER BY created_at DESC, id DESC LIMIT ?';
    const rows = this.db.prepare(sql).all(convId, cutoffId, limit) as unknown as MessageRow[];
    return rows.reverse();
  }

  /** 取某对话的消息（管理面板用） */
  getConversationMessages(conversationId: string, limit = 200): MessageRow[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(conversationId, limit) as unknown as MessageRow[];
    return rows.reverse();
  }

  /** 取某会话在指定消息 id 之后的消息（用于摘要后的增量） */
  getMessagesAfterId(scope: string, afterId: number, limit = 500): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE scope = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(scope, afterId, limit) as unknown as MessageRow[];
  }

  /** 取当前对话未摘要的消息 */
  getUnsummarizedMessages(scope: string, limit = 500, conversationId?: string, cutoffId = Number.MAX_SAFE_INTEGER): MessageRow[] {
    const convId = this.resolveConversation(scope, conversationId);
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND id <= ? AND summarized = 0 ORDER BY id ASC LIMIT ?')
      .all(convId, cutoffId, limit) as unknown as MessageRow[];
  }

  countUnsummarized(scope: string, conversationId?: string): number {
    const convId = this.resolveConversation(scope, conversationId);
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND summarized = 0')
      .get(convId) as { n: number };
    return r.n;
  }

  markSummarized(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('UPDATE messages SET summarized = 1 WHERE id = ?');
    for (const id of ids) stmt.run(id);
  }

  /** 搜索消息内容（供面板/检索用） */
  searchMessages(keyword: string, limit = 50): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?')
      .all(`%${keyword}%`, limit) as unknown as MessageRow[];
  }

  /** 统计某用户在某会话的互动次数 */
  countUserMessages(scope: string, userId: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE scope = ? AND user_id = ?')
      .get(scope, userId) as { n: number };
    return r.n;
  }

  /**
   * 取「机器人上次发言之后」的消息，时间正序。
   *
   * 被动回复时回看图片用这个：只有这段时间里出现的图才是"还没被回应过的新图"。
   * 用 id 比较而不是时间戳 —— 同一毫秒内的多条消息用时间戳会全被漏掉。
   */
  getMessagesSinceLastAssistant(scope: string, limit = 20, conversationId?: string, cutoffId = Number.MAX_SAFE_INTEGER): MessageRow[] {
    const convId = this.resolveConversation(scope, conversationId);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND id <= ?
           AND id > COALESCE(
             (SELECT MAX(id) FROM messages WHERE conversation_id = ? AND role = 'assistant' AND id <= ?),
             0
           )
         ORDER BY id DESC LIMIT ?`,
      )
      .all(convId, cutoffId, convId, cutoffId, limit) as unknown as MessageRow[];
    return rows.reverse();
  }

  /** 某会话里机器人最后一次发言的时间（0 = 从没说过） */
  getLastAssistantAt(scope: string): number {
    const convId = this.currentConversationId(scope);
    const r = this.db
      .prepare(
        "SELECT created_at FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(convId) as { created_at: number } | undefined;
    return r?.created_at ?? 0;
  }

  /**
   * 统计「机器人上次发言之后」有多少条别人的消息。
   *
   * 按**消息 id** 而不是时间戳比较：同一毫秒内可以插入多条消息，
   * 用 `created_at > t` 会把同一毫秒的消息全部漏掉（实测踩过）。
   * id 是单调递增的，不受时钟精度影响。
   */
  countUserMessagesSinceLastAssistant(scope: string): number {
    const convId = this.currentConversationId(scope);
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE conversation_id = ? AND role = 'user'
           AND id > COALESCE(
             (SELECT MAX(id) FROM messages WHERE conversation_id = ? AND role = 'assistant'),
             0
           )`,
      )
      .get(convId, convId) as { n: number };
    return r.n;
  }

  // ==================== 长期事实 ====================

  private factListeners = new Set<(userId: number) => void>();
  onFactChange(listener: (userId: number) => void): void { this.factListeners.add(listener); }
  notifyFactChange(userId: number): void { for (const listener of this.factListeners) listener(userId); }

  addFact(input: FactInput): number {
    const duplicate = this.findSimilarFact(input.userId, input.content, input.scope);
    if (duplicate) return duplicate.id;
    if (input.replacesId) {
      const previous = this.db.prepare('SELECT * FROM memory_facts WHERE id=? AND user_id=? AND scope=? AND fact_type=? AND active=1').get(input.replacesId,input.userId,input.scope,input.factType);
      if (!previous) throw new Error('替换事实归属或版本无效');
    }
    const ownTransaction=!this.db.isTransaction;if(ownTransaction)this.db.exec('BEGIN IMMEDIATE');
    try {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO memory_facts(
           user_id, scope, fact_type, content, keywords, confidence, shareable, source_msg_id, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.userId,
        input.scope,
        input.factType,
        input.content,
        memoryTerms(`${input.content} ${input.keywords ?? ''}`).join(' '),
        input.confidence ?? 0.8,
        input.shareable ? 1 : 0,
        input.sourceMsgId ?? null,
        now,
        now,
      );
    if (input.replacesId) {
      this.db.prepare('UPDATE memory_facts SET active=0,updated_at=? WHERE id=?').run(now,input.replacesId);
      this.db.prepare('UPDATE memory_facts SET replaces_id=? WHERE id=?').run(input.replacesId,Number(info.lastInsertRowid));
      this.deleteFactEmbedding(input.replacesId);
    }
    if(ownTransaction)this.db.exec('COMMIT');
    this.notifyFactChange(input.userId);
    return Number(info.lastInsertRowid);
    } catch(e){if(ownTransaction && this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
  }

  /** 查找同用户同类型且内容高度相同的事实，用于去重 */
  findSimilarFact(userId: number, content: string, scope?: string): FactRow | undefined {
    const rows = this.db.prepare('SELECT * FROM memory_facts WHERE user_id=? AND active=1' + (scope ? ' AND scope=?' : '')).all(userId,...(scope ? [scope] : [])) as unknown as FactRow[];
    return rows.find(row => normalizeFact(row.content) === normalizeFact(content));
  }

  getFactsByUser(userId: number, opts: { scope?: string; shareableOnly?: boolean; sharing?: 'none' | 'identity-facts' | 'full'; limit?: number } = {}): FactRow[] {
    const limit = opts.limit ?? 100;
    const conds = ['user_id = ?', 'active = 1'];
    const params: Array<string | number> = [userId];
    if (opts.scope) {
      // 本会话的事实 + 可跨会话共享的事实
      if (opts.shareableOnly) {
        conds.push('(scope = ? OR (shareable = 1 AND private = 0))');
      } else {
        conds.push(opts.sharing === 'full' ? '(scope = ? OR private = 0)' : 'scope = ?');
      }
      params.push(opts.scope);
    } else if (opts.shareableOnly) {
      conds.push('shareable = 1 AND private = 0');
    }
    params.push(limit);
    return this.db
      .prepare(`SELECT * FROM memory_facts WHERE ${conds.join(' AND ')} ORDER BY confidence DESC, updated_at DESC LIMIT ?`)
      .all(...params) as unknown as FactRow[];
  }

  /**
   * FTS 检索事实
   * 返回按相关度 + 时间衰减加权排序的结果
   */
  searchFacts(
    userId: number,
    query: string,
    opts: { scope?: string; shareableOnly?: boolean; sharing?: 'none' | 'identity-facts' | 'full'; limit?: number; halfLifeDays?: number } = {},
  ): Array<FactRow & { score: number }> {
    const limit = opts.limit ?? 20;
    const halfLifeDays = opts.halfLifeDays ?? 30;

    const terms = memoryTerms(query).slice(0, 15);
    if (!terms.length) return [];
    const conditions = ['f.user_id = ?', 'f.active = 1']; const permission: Array<string | number> = [userId];
    if (opts.scope) { conditions.push(opts.sharing === 'full' ? '(f.scope = ? OR f.private = 0)' : opts.shareableOnly ? '(f.scope = ? OR (f.shareable = 1 AND f.private = 0))' : 'f.scope = ?'); permission.push(opts.scope); }
    else if (opts.shareableOnly) conditions.push('f.shareable = 1 AND f.private = 0');
    const where = conditions.join(' AND ');
    let rows: FactRow[] = [];
    try {
      rows = this.db.prepare(`SELECT f.* FROM memory_facts_fts JOIN memory_facts f ON f.id=memory_facts_fts.rowid
        WHERE memory_facts_fts MATCH ? AND ${where} ORDER BY bm25(memory_facts_fts) LIMIT ?`)
        .all(terms.map(t => '"' + t.replace(/"/g,'""') + '"').join(' OR '), ...permission, limit * 3) as unknown as FactRow[];
    } catch { /* LIKE 仍可检索旧库未分词的事实 */ }
    const like = terms.map(() => "(f.content LIKE ? ESCAPE '\\' OR f.keywords LIKE ? ESCAPE '\\')").join(' OR ');
    const likeParams = terms.flatMap(t => { const v = '%' + t.replace(/[\\%_]/g, x => '\\' + x) + '%'; return [v,v]; });
    const fallback = this.db.prepare(`SELECT f.* FROM memory_facts f WHERE ${where} AND (${like}) ORDER BY updated_at DESC LIMIT ?`)
      .all(...permission, ...likeParams, limit * 3) as unknown as FactRow[];
    const filtered = [...new Map([...rows, ...fallback].map(f => [f.id,f])).values()];

    // 时间衰减加权：越久没被想起的事实分数越低
    const now = Date.now();
    const scored = filtered.map((f) => {
      const ageDays = (now - f.updated_at) / 86400000;
      const decay = Math.pow(0.5, ageDays / (['identity', 'skill'].includes(f.fact_type) ? Math.max(halfLifeDays, 365) : halfLifeDays));
      const score = f.confidence * (0.5 + 0.5 * decay) + Math.min(f.hit_count, 5) * 0.05;
      return { ...f, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** 记录事实被召回 */
  markFactsHit(ids: number[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE memory_facts SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  }

  deleteFact(id: number): void {
    const fact = this.db.prepare('SELECT * FROM memory_facts WHERE id=?').get(id) as FactRow | undefined;
    if (!fact) return;
    const cutoff = (this.db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM messages WHERE user_id=?').get(fact.user_id) as { n: number }).n;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO memory_forgetting(user_id,scope,content,source_msg_id,cutoff,created_at) VALUES(?,?,?,?,?,?)').run(fact.user_id,fact.scope,fact.content,fact.source_msg_id,cutoff,Date.now());
      this.db.prepare('DELETE FROM summaries WHERE scope=? AND (id IN (SELECT summary_id FROM summary_sources WHERE message_id=?) OR id NOT IN (SELECT summary_id FROM summary_sources))').run(fact.scope,fact.source_msg_id ?? -1);
      this.db.prepare('DELETE FROM memory_facts WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ==================== 向量（语义检索） ====================
  // 说明：只有配置了 embedding 模型后才会写入数据；未配置时下面这些方法
  // 返回空/0，检索逻辑自动退回关键词匹配，不影响原有行为。

  /** 保存/更新一条事实的向量 */
  saveFactEmbedding(factId: number, vec: number[], model: string): void {
    if (vec.length === 0) return;
    const fact=this.db.prepare('SELECT content FROM memory_facts WHERE id=?').get(factId) as {content:string}|undefined;if(!fact)return;
    this.db
      .prepare(
        `INSERT INTO fact_embeddings(fact_id, dim, vec, model, created_at,source_content,content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fact_id) DO UPDATE SET dim=excluded.dim, vec=excluded.vec,
           model=excluded.model, created_at=excluded.created_at,source_content=excluded.source_content,content_hash=excluded.content_hash`,
      )
      .run(factId, vec.length, vectorToBlob(vec), model, Date.now(),fact.content,createHash('sha256').update(fact.content).digest('hex'));
  }

  /** 已写入向量的模型名（用于判断换模型后是否需要重算） */
  getFactEmbeddingModel(factId: number): string | undefined {
    const row = this.db.prepare('SELECT model FROM fact_embeddings WHERE fact_id = ?').get(factId) as
      | { model: string }
      | undefined;
    return row?.model;
  }

  /** 统计缺少（或模型不匹配）向量的用户事实条数 */
  countFactsMissingEmbedding(userId: number, model: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_facts f
         LEFT JOIN fact_embeddings e ON e.fact_id = f.id
         WHERE f.user_id = ? AND f.active = 1 AND (e.fact_id IS NULL OR e.model <> ? OR e.source_content <> f.content)`,
      )
      .get(userId, model) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** 取出缺少向量的用户事实（用于按需补算） */
  listFactsMissingEmbedding(userId: number, model: string, limit = 50): FactRow[] {
    return this.db
      .prepare(
        `SELECT f.* FROM memory_facts f
         LEFT JOIN fact_embeddings e ON e.fact_id = f.id
         WHERE f.user_id = ? AND (e.fact_id IS NULL OR e.model <> ?)
         ORDER BY f.updated_at DESC LIMIT ?`,
      )
      .all(userId, model, limit) as unknown as FactRow[];
  }

  /** 向量检索事实（余弦相似度） */
  searchFactsByVector(
    userId: number,
    queryVec: number[],
    opts: { scope?: string; shareableOnly?: boolean; sharing?: 'none' | 'identity-facts' | 'full'; limit?: number; minScore?: number; model?: string } = {},
  ): Array<FactRow & { score: number; similarity: number }> {
    const limit = opts.limit ?? 20;
    const minScore = opts.minScore ?? 0.35;
    if (queryVec.length === 0) return [];

    const rows = this.db
      .prepare(
        `SELECT f.*, e.vec AS _vec FROM memory_facts f
         JOIN fact_embeddings e ON e.fact_id = f.id
         WHERE f.user_id = ? AND f.active = 1 AND e.source_content = f.content AND e.dim = ? ${opts.model ? 'AND e.model = ?' : ''}
         ${opts.scope ? (opts.sharing === 'full' ? 'AND (f.scope = ? OR f.private = 0)' : opts.shareableOnly ? 'AND (f.scope = ? OR (f.shareable = 1 AND f.private = 0))' : 'AND f.scope = ?') : (opts.shareableOnly ? 'AND f.shareable = 1 AND f.private = 0' : '')}
         ORDER BY f.updated_at DESC LIMIT 5000`,
      )
      .all(
        ...(opts.model ? [userId, queryVec.length, opts.model] : [userId, queryVec.length]),
        ...(opts.scope ? [opts.scope] : []),
      ) as unknown as Array<FactRow & { _vec: Uint8Array }>;

    const scored: Array<FactRow & { score: number; similarity: number }> = [];

    for (const r of rows) {

      if (!opts.scope && opts.shareableOnly && r.shareable !== 1) continue;

      let sim: number;
      try { sim = cosineSimilarity(queryVec, blobToVector(r._vec)); } catch { continue; }
      if (sim < minScore) continue;

      const { _vec, ...fact } = r;
      void _vec;
      scored.push({ ...(fact as FactRow), similarity: sim, score: sim * (0.5 + 0.5 * fact.confidence) });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** 删除一条事实的向量 */
  deleteFactEmbedding(factId: number): void {
    this.db.prepare('DELETE FROM fact_embeddings WHERE fact_id = ?').run(factId);
  }

  /** 向量库统计 */
  embeddingStats(): { total: number; models: Array<{ model: string; count: number }> } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM fact_embeddings').get() as { n: number }).n;
    const models = this.db
      .prepare('SELECT model, COUNT(*) AS count FROM fact_embeddings GROUP BY model ORDER BY count DESC')
      .all() as unknown as Array<{ model: string; count: number }>;
    return { total, models };
  }

  listFacts(userId?: number, limit = 200): FactRow[] {
    if (userId !== undefined) {
      return this.db
        .prepare('SELECT * FROM memory_facts WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?')
        .all(userId, limit) as unknown as FactRow[];
    }
    return this.db
      .prepare('SELECT * FROM memory_facts ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as unknown as FactRow[];
  }

  // ==================== 摘要 ====================

  addSummary(
    scope: string,
    level: number,
    content: string,
    msgFromId: number | null,
    msgToId: number | null,
    msgCount: number,
    conversationId?: string,
  ): number {
    const convId = this.resolveConversation(scope, conversationId);
    const info = this.db
      .prepare(
        'INSERT INTO summaries(scope, conversation_id, level, content, msg_from_id, msg_to_id, msg_count, tokens, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(scope, convId, level, content, msgFromId, msgToId, msgCount, estimateTokens(content), Date.now());
    this.db.prepare('UPDATE sessions SET summary_level = ? WHERE scope = ? AND ? > summary_level').run(level, scope, level);
    return Number(info.lastInsertRowid);
  }

  /** 取当前对话的摘要（多话题隔离：不会串到别的话题） */
  commitSummary(scope: string, conversationId: string, level: number, content: string, messageIds: number[], sourceSummaryIds: number[] = []): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.getConversation(conversationId)?.scope !== scope) throw new Error('话题已删除或归属不匹配');
      const originals = new Set(messageIds);
      const children: SummaryRow[] = [];
      for (const id of messageIds) {
        const row = this.db.prepare('SELECT conversation_id,summarized FROM messages WHERE id=?').get(id) as { conversation_id: string; summarized: number } | undefined;
        if (!row || row.conversation_id !== conversationId || row.summarized) throw new Error('摘要消息已被其他任务处理');
      }
      for (const id of sourceSummaryIds) {
        const child = this.db.prepare('SELECT * FROM summaries WHERE id=? AND conversation_id=? AND NOT EXISTS(SELECT 1 FROM summary_coverage WHERE child_id=summaries.id)').get(id, conversationId) as unknown as SummaryRow | undefined;
        if (!child) throw new Error('摘要源已被其他任务处理');
        children.push(child);
        const source = this.db.prepare('SELECT message_id FROM summary_sources WHERE summary_id=?').all(id) as unknown as { message_id: number }[];
        for (const row of source) originals.add(row.message_id);
      }
      const starts = [...messageIds, ...children.map(c => c.msg_from_id).filter((id): id is number => id !== null)];
      const ends = [...messageIds, ...children.map(c => c.msg_to_id).filter((id): id is number => id !== null)];
      const summaryId = this.addSummary(scope, level, content, starts.length ? Math.min(...starts) : null,
        ends.length ? Math.max(...ends) : null, originals.size || children.reduce((sum, c) => sum + c.msg_count, 0), conversationId);
      for (const id of originals) this.db.prepare('INSERT INTO summary_sources(summary_id,message_id) VALUES(?,?)').run(summaryId, id);
      this.markSummarized(messageIds);
      for (const child of sourceSummaryIds) this.db.prepare('INSERT INTO summary_coverage(child_id,parent_id) VALUES(?,?)').run(child, summaryId);
      this.db.exec('COMMIT'); return summaryId;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getSummaries(scope: string, level?: number, limit = 20, conversationId?: string): SummaryRow[] {
    const convId = this.resolveConversation(scope, conversationId);
    const sql = level
      ? 'SELECT * FROM summaries WHERE conversation_id = ? AND level = ? AND NOT EXISTS(SELECT 1 FROM summary_coverage WHERE child_id=summaries.id) ORDER BY created_at DESC,id DESC LIMIT ?'
      : 'SELECT * FROM summaries WHERE conversation_id = ? AND NOT EXISTS(SELECT 1 FROM summary_coverage WHERE child_id=summaries.id) ORDER BY level DESC,created_at DESC,id DESC LIMIT ?';
    const rows = level
      ? (this.db.prepare(sql).all(convId, level, limit) as unknown as SummaryRow[])
      : (this.db.prepare(sql).all(convId, limit) as unknown as SummaryRow[]);
    return rows;
  }

  /** 取当前对话最新一条摘要（任意层级） */
  getLatestSummary(scope: string): SummaryRow | undefined {
    const convId = this.currentConversationId(scope);
    return this.db
      .prepare('SELECT * FROM summaries WHERE conversation_id = ? AND NOT EXISTS(SELECT 1 FROM summary_coverage WHERE child_id=summaries.id) ORDER BY level DESC, created_at DESC,id DESC LIMIT 1')
      .get(convId) as SummaryRow | undefined;
  }

  countSummaries(scope: string, level: number, conversationId?: string): number {
    const convId = this.resolveConversation(scope, conversationId);
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM summaries WHERE conversation_id = ? AND level = ? AND NOT EXISTS(SELECT 1 FROM summary_coverage WHERE child_id=summaries.id)')
      .get(convId, level) as { n: number };
    return r.n;
  }

  // ==================== 情绪 ====================

  /** 读取用户在某会话的情绪状态 */
  getEmotionState(userId: number, scope: string): EmotionStateRow | undefined {
    return this.db
      .prepare('SELECT * FROM user_emotion_state WHERE user_id = ? AND scope = ?')
      .get(userId, scope) as EmotionStateRow | undefined;
  }

  /**
   * 用 EMA 平滑更新用户情绪状态
   * @param smoothing 0~1，越大越跟随最新值
   */
  updateEmotionState(
    userId: number,
    scope: string,
    score: EmotionScore,
    smoothing: number,
    now = Date.now(),
  ): EmotionStateRow {
    const prev = this.getEmotionState(userId, scope);
    const a = Math.max(0, Math.min(1, smoothing));

    let next: Omit<EmotionStateRow, 'user_id' | 'scope'>;
    if (!prev) {
      next = {
        label: score.label,
        valence: score.valence,
        arousal: score.arousal,
        dominance: score.dominance,
        intensity: score.intensity,
        confidence: score.confidence,
        samples: 1,
        updated_at: now,
      };
    } else {
      const mix = (o: number, n: number) => o * (1 - a) + n * a;
      next = {
        // 标签取最新一次（简单可靠）；状态量做平滑
        label: score.label,
        valence: mix(prev.valence, score.valence),
        arousal: mix(prev.arousal, score.arousal),
        dominance: mix(prev.dominance, score.dominance),
        intensity: mix(prev.intensity, score.intensity),
        confidence: mix(prev.confidence, score.confidence),
        samples: prev.samples + 1,
        updated_at: now,
      };
    }

    this.db
      .prepare(
        `INSERT INTO user_emotion_state(user_id, scope, label, valence, arousal, dominance, intensity, confidence, samples, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, scope) DO UPDATE SET
           label=excluded.label, valence=excluded.valence, arousal=excluded.arousal,
           dominance=excluded.dominance, intensity=excluded.intensity,
           confidence=excluded.confidence, samples=excluded.samples, updated_at=excluded.updated_at`,
      )
      .run(
        userId,
        scope,
        next.label,
        next.valence,
        next.arousal,
        next.dominance,
        next.intensity,
        next.confidence,
        next.samples,
        next.updated_at,
      );

    this.db
      .prepare(
        'INSERT INTO emotion_history(user_id, scope, label, valence, arousal, dominance, intensity, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(userId, scope, score.label, score.valence, score.arousal, score.dominance, score.intensity, now);

    return this.getEmotionState(userId, scope)!;
  }

  /** 情绪历史曲线 */
  getEmotionHistory(userId: number, opts: { scope?: string; limit?: number } = {}): Array<{
    label: string;
    valence: number;
    arousal: number;
    dominance: number;
    intensity: number;
    created_at: number;
  }> {
    const limit = opts.limit ?? 100;
    if (opts.scope) {
      return this.db
        .prepare(
          'SELECT label, valence, arousal, dominance, intensity, created_at FROM emotion_history WHERE user_id = ? AND scope = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(userId, opts.scope, limit) as never;
    }
    return this.db
      .prepare(
        'SELECT label, valence, arousal, dominance, intensity, created_at FROM emotion_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(userId, limit) as never;
  }

  // ==================== 群成员 ====================

  touchGroupMember(
    groupId: number,
    userId: number,
    card: string,
    nickname: string,
    role: string,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO group_members(group_id, user_id, card, nickname, role, message_count, last_active)
         VALUES (?,?,?,?,?,1,?)
         ON CONFLICT(group_id, user_id) DO UPDATE SET
           card=excluded.card, nickname=excluded.nickname, role=excluded.role,
           message_count=group_members.message_count + 1, last_active=excluded.last_active`,
      )
      .run(groupId, userId, card, nickname, role, now);
  }

  getGroupMember(groupId: number, userId: number): { group_id: number; user_id: number; card: string; nickname: string; role: string; message_count: number } | undefined {
    return this.db
      .prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(groupId, userId) as never;
  }

  listGroupMembers(groupId: number, limit = 100): Array<{ user_id: number; card: string; nickname: string; role: string; message_count: number }> {
    return this.db
      .prepare('SELECT user_id, card, nickname, role, message_count FROM group_members WHERE group_id = ? ORDER BY message_count DESC LIMIT ?')
      .all(groupId, limit) as never;
  }

  // ==================== 主动发言记录 ====================

  logProactive(scope: string, reason: string, content: string, now = Date.now()): void {
    this.db
      .prepare('INSERT INTO proactive_log(scope, reason, content, created_at) VALUES (?,?,?,?)')
      .run(scope, reason, content, now);
  }

  /** 统计某会话在时间窗口内的主动发言次数 */
  countProactiveSince(scope: string, sinceMs: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM proactive_log WHERE scope = ? AND created_at >= ?')
      .get(scope, sinceMs) as { n: number };
    return r.n;
  }

  getLastProactive(scope: string): { created_at: number } | undefined {
    return this.db
      .prepare('SELECT created_at FROM proactive_log WHERE scope = ? ORDER BY created_at DESC LIMIT 1')
      .get(scope) as { created_at: number } | undefined;
  }

  // ==================== 统计 ====================

  stats(): {
    users: number;
    sessions: number;
    messages: number;
    facts: number;
    summaries: number;
    emotionRecords: number;
  } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      users: one('SELECT COUNT(*) AS n FROM users'),
      sessions: one('SELECT COUNT(*) AS n FROM sessions'),
      messages: one('SELECT COUNT(*) AS n FROM messages'),
      facts: one('SELECT COUNT(*) AS n FROM memory_facts'),
      summaries: one('SELECT COUNT(*) AS n FROM summaries'),
      emotionRecords: one('SELECT COUNT(*) AS n FROM emotion_history'),
    };
  }
}

/** 索引和检索共用中文二元词，保持老 unicode61 表兼容。 */
export function memoryTerms(text: string): string[] {
  const terms: string[] = [];
  for (const word of text.normalize('NFKC').toLowerCase().match(/[\u4e00-\u9fff]+|[a-z0-9_.+-]+/g) ?? []) {
    if (/^[\u4e00-\u9fff]+$/.test(word) && word.length > 2) for (let i=0;i<word.length-1;i++) terms.push(word.slice(i,i+2));
    else terms.push(word);
  }
  return [...new Set(terms)];
}

export function normalizeFact(content: string): string { return content.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,''); }
