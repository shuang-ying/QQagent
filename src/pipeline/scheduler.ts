import type { AppConfig } from '../core/types.js';
type Job = { priority: number; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
type ScopeQueue = { active: boolean; jobs: Job[] };
export class ScheduleRejected extends Error {}

/** 每个 scope 串行、不同 scope 并行；准入时即占用额度，完成时释放。 */
export class SessionScheduler {
  private stopped = false;
  stop(): void { this.stopped=true;for(const [scope,queue] of this.queues){for(const job of queue.jobs){this.pending--;job.reject(new ScheduleRejected('正在关闭'));}queue.jobs=[];if(!queue.active)this.queues.delete(scope);} }
  private queues = new Map<string, ScopeQueue>();
  private active = 0;
  private pending = 0;
  constructor(private readonly limits: Pick<AppConfig['scheduling'], 'maxPendingPerScope' | 'maxPendingTotal' | 'maxActiveScopes'>) {}
  get stats() { return { scopes: this.queues.size, active: this.active, pending: this.pending }; }
  enqueue<T>(scope: string, task: () => Promise<T>, priority = 1): Promise<T> {
    if(this.stopped)return Promise.reject(new ScheduleRejected('正在关闭'));
    const existing = this.queues.get(scope);
    const perScope = (existing?.jobs.length ?? 0) + (existing?.active ? 1 : 0);
    if (perScope >= this.limits.maxPendingPerScope || this.pending >= this.limits.maxPendingTotal) {
      return Promise.reject(new ScheduleRejected('回复队列已达到上限'));
    }
    const queue = existing ?? { active: false, jobs: [] };
    this.queues.set(scope, queue); this.pending++;
    const result = new Promise<T>((resolve, reject) => {
      queue.jobs.push({ priority, run: task, resolve: v => resolve(v as T), reject });
      queue.jobs.sort((a, b) => a.priority - b.priority);
    });
    this.pump(); return result;
  }
  private pump(): void {
    for (const [scope, queue] of [...this.queues].sort((a, b) => (a[1].jobs[0]?.priority ?? 99) - (b[1].jobs[0]?.priority ?? 99))) {
      if (this.active >= this.limits.maxActiveScopes) break;
      if (queue.active || queue.jobs.length === 0) continue;
      const job = queue.jobs.shift()!; queue.active = true; this.active++;
      const complete = () => {
        this.active--; this.pending--; queue.active = false;
        // 放到队尾，让其他会话先取得并发名额。
        this.queues.delete(scope);
        if (queue.jobs.length > 0) this.queues.set(scope, queue);
        this.pump();
      };
      void Promise.resolve().then(job.run).then(value => { complete(); job.resolve(value); },
        error => { complete(); job.reject(error); });
    }
  }
}
