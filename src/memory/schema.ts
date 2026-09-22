/**
 * 数据库 Schema（SQLite，使用 Node 24 内置 node:sqlite，零原生依赖）
 *
 * 设计要点：
 *  - users 以 QQ 号为主键 —— 这是跨会话的唯一身份
 *  - sessions 是会话单元：private:{qq} 或 group:{gid}
 *  - messages 全量留档，含情绪标注与 token 数
 *  - memory_facts 长期事实，带 scope 与共享标记（决定是否跨群可见）
 *  - summaries 分层摘要，支持 L1/L2/L3 递归压缩
 */
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- ============================================================
-- 用户：以 QQ 号为唯一 ID
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  user_id       INTEGER PRIMARY KEY,           -- QQ 号，全局唯一身份
  nickname      TEXT    NOT NULL DEFAULT '',   -- 最近一次见到的昵称
  aliases       TEXT    NOT NULL DEFAULT '[]', -- 见过的昵称/群名片历史 JSON 数组
  first_seen    INTEGER NOT NULL,              -- 首次见面时间戳(ms)
  last_seen     INTEGER NOT NULL,              -- 最近活跃时间戳(ms)
  message_count INTEGER NOT NULL DEFAULT 0,    -- 累计发言数
  persona_id    TEXT,                          -- 该用户私聊使用的人格（覆盖默认）
  notes         TEXT    NOT NULL DEFAULT ''    -- 人工备注
);

-- ============================================================
-- 会话：私聊或群聊
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  scope         TEXT    PRIMARY KEY,           -- private:123 / group:456
  scope_type    TEXT    NOT NULL,              -- private | group
  target_id     INTEGER NOT NULL,              -- 私聊=对方QQ；群聊=群号
  persona_id    TEXT,                          -- 该会话使用的人格（覆盖默认）
  title         TEXT    NOT NULL DEFAULT '',   -- 群名或对方昵称
  first_seen    INTEGER NOT NULL,
  last_active   INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  summary_level INTEGER NOT NULL DEFAULT 0,    -- 已压缩到的层级
  current_conversation_id TEXT                   -- 该会话当前激活的对话（多话题）
);
CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(scope_type, last_active DESC);

-- ============================================================
-- 对话：一个会话下的多个话题
--
-- 参考 AstrBot 的 session / conversation 分离：
--   会话(session) = 私聊或某个群，标记"对话窗口"
--   对话(conversation) = 窗口里的一条话题线，可新建/切换/改名/删除
-- 人格与 token 用量挂在对话上，这样"开个新话题"不会丢人格，
-- 也不会把旧话题的上下文混进来。
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT    PRIMARY KEY,           -- uuid
  scope         TEXT    NOT NULL,              -- 归属会话
  title         TEXT    NOT NULL DEFAULT '',   -- 话题标题（可自动生成/手动改）
  persona_id    TEXT,                          -- 该对话使用的人格（覆盖会话/默认）
  token_usage   INTEGER NOT NULL DEFAULT 0,    -- 该对话累计消耗 token
  archived      INTEGER NOT NULL DEFAULT 0,    -- 归档（不再出现在默认列表）
  first_seen    INTEGER NOT NULL,
  last_active   INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_scope ON conversations(scope, archived, last_active DESC);

-- ============================================================
-- 消息：全量留档
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scope         TEXT    NOT NULL,              -- 会话
  conversation_id TEXT,                        -- 所属对话（旧数据为 NULL，迁移时回填）
  user_id       INTEGER NOT NULL,              -- 说话人 QQ（记忆归属者）
  role          TEXT    NOT NULL,              -- user | assistant
  content       TEXT    NOT NULL,              -- 纯文本内容
  raw_segments  TEXT,                          -- 原始消息段 JSON（可选）
  message_id    INTEGER,                       -- QQ 消息 id
  sender_name   TEXT    NOT NULL DEFAULT '',
  tokens        INTEGER NOT NULL DEFAULT 0,
  -- 情绪标注
  emotion_label TEXT,
  emotion_valence   REAL,
  emotion_arousal   REAL,
  emotion_dominance REAL,
  emotion_intensity REAL,
  -- 该消息是否已被摘要覆盖（压缩后置 1，原文仍保留）
  summarized    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_scope_time ON messages(scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_user_time  ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_unsummarized ON messages(scope, summarized, created_at) WHERE summarized = 0;
-- 注意：messages(conversation_id) 的索引不在这里建。
-- 老库的 messages 表已存在且没有该列，而 CREATE TABLE IF NOT EXISTS 不会加列，
-- 于是这里的 CREATE INDEX 会直接报 "no such column"。
-- 索引统一放到 migrateToConversations() 里、ALTER TABLE 补列之后再建。

-- ============================================================
-- 长期事实：从对话中抽取的稳定信息
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,                -- 归属用户 QQ
  scope       TEXT    NOT NULL,                -- 产生该事实的会话
  fact_type   TEXT    NOT NULL,                -- identity|preference|skill|goal|relation|event|other
  content     TEXT    NOT NULL,                -- 事实内容
  keywords    TEXT    NOT NULL DEFAULT '',     -- 检索关键词（空格分隔）
  confidence  REAL    NOT NULL DEFAULT 0.8,    -- 置信度 0~1
  shareable   INTEGER NOT NULL DEFAULT 0,      -- 1 = 可跨会话共享（身份类事实）
  source_msg_id INTEGER,                       -- 来源消息
  hit_count   INTEGER NOT NULL DEFAULT 0,      -- 被召回次数
  last_hit_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_user  ON memory_facts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_scope ON memory_facts(scope);
CREATE INDEX IF NOT EXISTS idx_facts_share ON memory_facts(user_id, shareable);

-- 事实全文检索
CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
  content, keywords,
  content='memory_facts',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- 保持 FTS 与主表同步
CREATE TRIGGER IF NOT EXISTS trg_facts_ai AFTER INSERT ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;
CREATE TRIGGER IF NOT EXISTS trg_facts_ad AFTER DELETE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(memory_facts_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords);
END;
CREATE TRIGGER IF NOT EXISTS trg_facts_au AFTER UPDATE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(memory_facts_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords);
  INSERT INTO memory_facts_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;

-- ============================================================
-- 事实向量：语义检索
-- 仅在「模型用途 -> 向量化」配置了 embedding 模型后才会写入；
-- 未配置时该表为空，检索自动退回 FTS 关键词匹配。
-- ============================================================
CREATE TABLE IF NOT EXISTS fact_embeddings (
  fact_id    INTEGER PRIMARY KEY,
  dim        INTEGER NOT NULL,
  vec        BLOB    NOT NULL,                 -- Float32Array 原始字节
  model      TEXT    NOT NULL DEFAULT '',      -- 生成该向量的模型，换模型后需重算
  created_at INTEGER NOT NULL,
  FOREIGN KEY (fact_id) REFERENCES memory_facts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_fact_emb_model ON fact_embeddings(model);

-- ============================================================
-- 摘要：分层压缩
-- ============================================================
CREATE TABLE IF NOT EXISTS summaries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT    NOT NULL,
  conversation_id TEXT,                        -- 所属对话（多话题：摘要按话题隔离）
  level       INTEGER NOT NULL DEFAULT 1,      -- 1=短期 L2=中期 L3=长期
  content     TEXT    NOT NULL,
  msg_from_id INTEGER,                         -- 覆盖的消息区间
  msg_to_id   INTEGER,
  msg_count   INTEGER NOT NULL DEFAULT 0,
  tokens      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_scope_level ON summaries(scope, level, created_at DESC);

-- ============================================================
-- 用户情绪状态：EMA 平滑后的当前情绪
-- ============================================================
CREATE TABLE IF NOT EXISTS user_emotion_state (
  user_id     INTEGER NOT NULL,
  scope       TEXT    NOT NULL,
  label       TEXT    NOT NULL DEFAULT 'neutral',
  valence     REAL    NOT NULL DEFAULT 0,
  arousal     REAL    NOT NULL DEFAULT 0.3,
  dominance   REAL    NOT NULL DEFAULT 0.5,
  intensity   REAL    NOT NULL DEFAULT 0,
  confidence  REAL    NOT NULL DEFAULT 0,
  samples     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope)
);

-- 情绪历史（用于曲线展示）
CREATE TABLE IF NOT EXISTS emotion_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  scope      TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  valence    REAL    NOT NULL,
  arousal    REAL    NOT NULL,
  dominance  REAL    NOT NULL,
  intensity  REAL    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emo_hist ON emotion_history(user_id, created_at DESC);

-- ============================================================
-- 群成员画像：群内互动关系
-- ============================================================
CREATE TABLE IF NOT EXISTS group_members (
  group_id     INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  card         TEXT    NOT NULL DEFAULT '',
  nickname     TEXT    NOT NULL DEFAULT '',
  role         TEXT    NOT NULL DEFAULT 'member',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_active  INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- ============================================================
-- 主动发言记录：用于频率限制与免打扰判断
-- ============================================================
CREATE TABLE IF NOT EXISTS proactive_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT    NOT NULL,
  reason     TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proactive ON proactive_log(scope, created_at DESC);

-- ============================================================
-- 元信息
-- ============================================================
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 生成一个对话 id（无需依赖 crypto 的 uuid） */
export function newConversationId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 给已存在的库补列（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS） */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/**
 * 迁移：把老库升级到「会话 / 对话分离」。
 *
 * 老库里 messages 只有 scope、sessions 没有 current_conversation_id。
 * 这里给每个已有会话建一个默认对话，把该会话的历史消息全部挂过去，
 * 并把会话的当前对话指向它。**幂等**：重复执行不会重复建对话。
 */
function migrateToConversations(db: DatabaseSync): void {
  addColumnIfMissing(db, 'sessions', 'current_conversation_id', 'TEXT');
  addColumnIfMissing(db, 'messages', 'conversation_id', 'TEXT');
  addColumnIfMissing(db, 'summaries', 'conversation_id', 'TEXT');

  // 补完列之后才能建这个索引（见 SCHEMA_SQL 里的说明）
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_conv_time ON messages(conversation_id, created_at DESC)');

  const now = Date.now();

  // 1) 给还没有「当前对话」的会话建默认对话
  const sessions = db
    .prepare('SELECT scope, scope_type, title, persona_id, first_seen, last_active FROM sessions')
    .all() as unknown as Array<{
    scope: string;
    scope_type: string;
    title: string;
    persona_id: string | null;
    first_seen: number;
    last_active: number;
  }>;

  for (const s of sessions) {
    const existing = db
      .prepare('SELECT id FROM conversations WHERE scope = ? ORDER BY last_active DESC LIMIT 1')
      .get(s.scope) as { id: string } | undefined;

    let convId = existing?.id;
    if (!convId) {
      convId = newConversationId();
      // persona_id 留 NULL = 继承会话/默认人格。
      // 不要把人格的 persona_id 抄进来：那样对话会永远压过会话设置，
      // 之后在会话级切换人格就失效了。
      db.prepare(
        `INSERT INTO conversations(id, scope, title, persona_id, token_usage, archived, first_seen, last_active, message_count)
         VALUES (?, ?, ?, NULL, 0, 0, ?, ?, 0)`,
      ).run(convId, s.scope, s.title || '默认话题', s.first_seen || now, s.last_active || now);
    }

    // 会话当前对话指向它（注意：SQLite 里 '' 才是空字符串，"" 会被当成标识符）
    db.prepare(
      `UPDATE sessions SET current_conversation_id = ?
       WHERE scope = ? AND (current_conversation_id IS NULL OR current_conversation_id = '')`,
    ).run(convId, s.scope);
  }

  // 2) 回填消息的 conversation_id（只回填还没挂的，幂等）
  const orphans = db
    .prepare(
      `SELECT DISTINCT m.scope AS scope FROM messages m
       WHERE m.conversation_id IS NULL OR m.conversation_id = ''`,
    )
    .all() as unknown as Array<{ scope: string }>;

  for (const o of orphans) {
    // 用该会话最早的对话承接历史（通常就是刚建的默认对话）
    let conv = db
      .prepare('SELECT id FROM conversations WHERE scope = ? ORDER BY first_seen ASC LIMIT 1')
      .get(o.scope) as { id: string } | undefined;

    if (!conv) {
      // 极端情况：消息有 scope 但 sessions 里没有对应会话
      const id = newConversationId();
      db.prepare(
        `INSERT INTO conversations(id, scope, title, persona_id, token_usage, archived, first_seen, last_active, message_count)
         VALUES (?, ?, ?, NULL, 0, 0, ?, ?, 0)`,
      ).run(id, o.scope, '默认话题', now, now);
      conv = { id };
    }

    db.prepare(
      `UPDATE messages SET conversation_id = ?
       WHERE scope = ? AND (conversation_id IS NULL OR conversation_id = '')`,
    ).run(conv.id, o.scope);
  }

  // 2b) 摘要也要挂上（独立遍历，因为可能存在"有摘要但消息已删"的会话）
  const sumScopes = db
    .prepare(
      `SELECT DISTINCT scope FROM summaries
       WHERE conversation_id IS NULL OR conversation_id = ''`,
    )
    .all() as unknown as Array<{ scope: string }>;

  for (const s of sumScopes) {
    const conv = db
      .prepare('SELECT id FROM conversations WHERE scope = ? ORDER BY first_seen ASC LIMIT 1')
      .get(s.scope) as { id: string } | undefined;
    if (!conv) continue;
    db.prepare(
      `UPDATE summaries SET conversation_id = ?
       WHERE scope = ? AND (conversation_id IS NULL OR conversation_id = '')`,
    ).run(conv.id, s.scope);
  }

  // 3) 重算每个对话的消息数与最后活跃（幂等，且能修正历史脏数据）
  db.exec(`
    UPDATE conversations SET
      message_count = (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = conversations.id),
      last_active   = COALESCE(
        (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = conversations.id),
        conversations.last_active
      )
  `);
}

/** 初始化数据库并返回连接 */
export function initDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  // 老库升级（新库也会跑一遍，但不会有副作用）
  try {
    migrateToConversations(db);
  } catch (e) {
    // 迁移失败不应该让程序起不来：记录后继续，功能退化为"单话题"
    console.error('[memory] 会话/对话迁移失败（将退化为单话题模式）:', (e as Error).message);
  }

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  } else if (row.value !== String(SCHEMA_VERSION)) {
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
  }
  return db;
}
