import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../core/logger.js';

export interface BackgroundJob {
  id: number; kind: string; scope: string; conversation_id: string;
  payload: string; state: string; attempts: number; error: string;
}
type Handler = (payload: any, signal: AbortSignal) => Promise<void>;

/** 单实例持久化队列；不执行 QQ 投递，恢复只涉及可去重的后台工作。 */
export class BackgroundQueue {
  private handlers = new Map<string, Handler>();
  private active = new Map<number, AbortController>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private db: DatabaseSync, private log: Logger, private foregroundBusy = () => false,
    private concurrency = 1, private retryMs = 1000) {
    db.exec(`CREATE TABLE IF NOT EXISTS background_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dedup_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      scope TEXT NOT NULL, conversation_id TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_jobs_ready ON background_jobs(state, available_at, id);
      UPDATE background_jobs SET state='queued' WHERE state='running';`);
  }
  register(kind: string, handler: Handler): void { this.handlers.set(kind, handler); this.wake(); }
  enqueue(key: string, kind: string, scope: string, conversationId: string, payload: unknown, delayMs = 0): number {
    if (this.stopped) throw new Error('后台队列已停止');
    const now = Date.now();
    this.db.prepare(`INSERT INTO background_jobs
      (dedup_key,kind,scope,conversation_id,payload,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedup_key) DO UPDATE SET payload=excluded.payload WHERE background_jobs.state='queued'`)
      .run(key, kind, scope, conversationId, JSON.stringify(payload), now + delayMs, now, now);
    const row = this.db.prepare('SELECT id FROM background_jobs WHERE dedup_key=?').get(key) as { id: number };
    this.wake(); return row.id;
  }
  list(): BackgroundJob[] { return this.db.prepare('SELECT * FROM background_jobs ORDER BY id').all() as unknown as BackgroundJob[]; }
  cancelScope(scope: string): void {
    const rows = this.db.prepare("SELECT id FROM background_jobs WHERE scope=? AND state IN ('queued','running')").all(scope) as unknown as { id: number }[];
    this.db.prepare("UPDATE background_jobs SET state='cancelled',updated_at=? WHERE scope=? AND state IN ('queued','running')").run(Date.now(), scope);
    for (const row of rows) this.active.get(row.id)?.abort();
  }
  wake(delayMs = 5): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, delayMs);
    this.timer.unref();
  }
  private pump(): void {
    if (this.stopped) return;
    if (this.foregroundBusy()) { this.wake(100); return; }
    const jobs = this.db.prepare("SELECT * FROM background_jobs WHERE state='queued' AND available_at<=? ORDER BY id LIMIT ?")
      .all(Date.now(), this.concurrency - this.active.size) as unknown as BackgroundJob[];
    for (const job of jobs) {
      const handler = this.handlers.get(job.kind); if (!handler) continue;
      const ctrl = new AbortController(); this.active.set(job.id, ctrl);
      this.db.prepare("UPDATE background_jobs SET state='running',attempts=attempts+1,updated_at=? WHERE id=? AND state='queued'").run(Date.now(), job.id);
      void Promise.resolve().then(() => handler(JSON.parse(job.payload), ctrl.signal)).then(() => {
        if (!this.stopped) this.db.prepare("UPDATE background_jobs SET state='succeeded',updated_at=? WHERE id=? AND state='running'").run(Date.now(), job.id);
      }, error => {
        if (!this.stopped && !ctrl.signal.aborted) {
          const state = job.attempts + 1 < 3 ? 'queued' : 'failed';
          this.db.prepare("UPDATE background_jobs SET state=?,error=?,available_at=?,updated_at=? WHERE id=? AND state='running'")
            .run(state, String(error?.message ?? error).slice(0, 300), Date.now() + this.retryMs * 2 ** job.attempts, Date.now(), job.id);
          this.log.warn({ jobId: job.id, state }, '后台任务失败');
        }
      }).finally(() => { this.active.delete(job.id); this.wake(); });
    }
    if (this.db.prepare("SELECT id FROM background_jobs WHERE state='queued' LIMIT 1").get()) this.wake(100);
  }
  get activeCount(): number {return this.active.size;}
  stop(): void {
    this.stopped = true; if (this.timer) clearTimeout(this.timer);
    for (const ctrl of this.active.values()) ctrl.abort();
    // running 保留，下一次启动恢复；运行中的 handler 必须在写入前检查取消。
  }
}
