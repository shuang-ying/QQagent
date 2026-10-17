import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from '../core/logger.js';
import { errorDetails } from '../core/logger.js';
import { installSnowLuma, snowLumaPaths } from './install.js';
import { releaseAsset, SNOWLUMA_VERSION } from './release.js';

type Phase = 'not_installed' | 'stopped' | 'installing' | 'starting' | 'running' | 'stopping' | 'error';
export interface TerminalLine { sequence: number; time: number; stream: 'stdout' | 'stderr' | 'system'; text: string }
export interface SnowLumaOptions {
  executable?: string; runner?: string; startupTimeoutMs?: number;
  disableAutoHook?: boolean;
  installer?: typeof installSnowLuma;
}
export class SnowLumaController {
  readonly paths;
  private phase: Phase = 'not_installed';
  private child?: ChildProcessWithoutNullStreams;
  private backendPort = 0;
  private startedAt = 0;
  private lastExitCode: number | null = null;
  private lastError = '';
  private sequence = 0;
  private lines: TerminalLine[] = [];
  private closed = false;
  private installation?: Promise<void>;
  private starting?: Promise<ReturnType<SnowLumaController['status']>>;
  private stopping?: Promise<void>;
  private operation?: AbortController;
  constructor(private root: string, private log: Logger, private options: SnowLumaOptions = {}) {
    this.paths = snowLumaPaths(root);
    if (this.installed()) this.phase = 'stopped';
  }
  private installed() {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(this.paths.distribution, 'installation.json'), 'utf8'));
      return manifest.version === SNOWLUMA_VERSION && manifest.platform === process.platform && manifest.arch === process.arch
        && fs.existsSync(path.join(this.paths.program, 'index.mjs'));
    } catch { return false; }
  }
  status() {
    let supported = true;
    try { releaseAsset(); } catch { supported = false; }
    return { phase: this.phase, installed: this.installed(), supported, version: SNOWLUMA_VERSION,
      pid: this.child?.pid ?? null, backendPort: this.backendPort, startedAt: this.startedAt,
      lastExitCode: this.lastExitCode, error: this.lastError,
      programDirectory: this.paths.program, sourceDirectory: this.paths.source, dataDirectory: this.paths.state };
  }
  terminal(after = 0) {
    const oldest = this.lines[0]?.sequence ?? this.sequence + 1;
    const reset = after < oldest - 1 || after > this.sequence;
    const entries = this.lines.filter(line => line.sequence > (reset ? oldest - 1 : after)).slice(0, 250);
    return { entries, reset, nextCursor: entries.at(-1)?.sequence ?? this.sequence };
  }
  private line(text: string, stream: TerminalLine['stream'] = 'system') {
    const clean = text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 4096);
    this.lines.push({ sequence: ++this.sequence, time: Date.now(), stream, text: clean });
    if (this.lines.length > 2000) this.lines.splice(0, this.lines.length - 2000);
  }
  private ensureOpen() { if (this.closed) throw new Error('SnowLuma 管理器正在关闭'); }
  install() {
    this.ensureOpen();
    if (this.installed()) return this.status();
    if (this.phase === 'installing') return this.status();
    if (this.child || this.starting || this.stopping) throw new Error('请停止 SnowLuma 后安装');
    this.phase = 'installing'; this.lastError = '';
    this.operation = new AbortController();
    this.installation = (this.options.installer ?? installSnowLuma)(this.root, text => this.line(text), this.operation.signal)
      .then(() => { this.phase = 'stopped'; }, error => {
        this.phase = 'error'; this.lastError = String(error.message ?? error);
        this.line('安装失败：' + this.lastError);
        this.log.warn({ ...errorDetails(error) }, 'SnowLuma 安装失败');
      }).finally(() => { this.installation = undefined; });
    return this.status();
  }
  start(): Promise<ReturnType<SnowLumaController['status']>> {
    this.ensureOpen();
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve(this.status());
    if (this.installation || this.stopping) throw new Error('SnowLuma 安装或停止尚未完成');
    if (!this.installed()) throw new Error('请先安装内置 SnowLuma');
    this.phase = 'starting'; this.lastError = ''; this.operation = new AbortController();
    this.starting = this.launch(this.operation.signal).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async launch(signal: AbortSignal) {
    try {
      this.backendPort = await new Promise<number>((resolve, reject) => {
        const probe = net.createServer(); probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
          const port = (probe.address() as net.AddressInfo).port;
          probe.close(error => error ? reject(error) : resolve(port));
        });
      });
      signal.throwIfAborted();
      fs.mkdirSync(this.paths.state, { recursive: true });
      const node = this.options.executable ?? path.join(this.paths.program, process.platform === 'win32' ? 'node.exe' : 'node');
      const runner = this.options.runner ?? path.join(this.root, 'scripts', 'snowluma-runner.mjs');
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ'])
        if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, { SNOWLUMA_WEBUI_PORT: String(this.backendPort), SNOWLUMA_WEBUI_HOST: '127.0.0.1',
        SNOWLUMA_WEBUI_TLS: '0', NO_COLOR: '1', FORCE_COLOR: '0' });
      // 常规运行沿用上游用户设置；隔离冒烟验证可显式禁用 QQ 自动接入。
      if (this.options.disableAutoHook) env.SNOWLUMA_HOOK_AUTOLOAD = '0';
      const child = spawn(node, [runner, path.join(this.paths.program, 'index.mjs')], {
        cwd: this.paths.state, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child; this.startedAt = Date.now(); this.lastExitCode = null;
      child.stdin.on('error', () => { /* 退出时关闭的 stdin 不造成未处理异常。 */ });
      for (const stream of ['stdout', 'stderr'] as const) {
        const decoder = new StringDecoder('utf8'); let pending = '';
        child[stream].on('data', data => {
          pending += decoder.write(data);
          const complete = pending.split(/\r\n|\n|\r/); pending = complete.pop() ?? '';
          for (const line of complete) this.line(line, stream);
          if (pending.length > 4096) { this.line(pending, stream); pending = ''; }
        });
        child[stream].on('end', () => { pending += decoder.end(); if (pending) this.line(pending, stream); });
      }
      child.once('error', error => { this.lastError = error.message; this.phase = 'error'; this.line('进程启动失败：' + error.message); });
      child.once('close', (code, exitSignal) => {
        if (this.child !== child) return;
        this.child = undefined; this.lastExitCode = code; this.backendPort = 0;
        if (this.phase !== 'error') this.phase = code === 0 || this.phase === 'stopping' ? 'stopped' : 'error';
        if (this.phase === 'error' && !this.lastError) this.lastError = `SnowLuma 异常退出（${code ?? exitSignal}）`;
        this.line(`SnowLuma 进程结束，退出码 ${code ?? exitSignal}`);
        this.log.info({ pid: child.pid, code, signal: exitSignal }, 'SnowLuma 独立进程结束');
      });
      this.line(`启动 SnowLuma 独立进程，PID ${child.pid ?? '-'}；请在原生界面登录并手动接入 QQ`);
      const deadline = Date.now() + (this.options.startupTimeoutMs ?? 20000);
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (this.child !== child || child.exitCode !== null) throw new Error(this.lastError || 'SnowLuma 启动时退出');
        try {
          const response = await fetch(this.backendUrl + '/', { signal: AbortSignal.any([signal, AbortSignal.timeout(800)]) });
          await response.body?.cancel();
          if (response.ok) {
            this.phase = 'running'; this.line('SnowLuma 管理界面已就绪');
            this.log.info({ pid: child.pid, port: this.backendPort }, 'SnowLuma 独立进程已启动');
            return this.status();
          }
        } catch { /* 进程仍在初始化。 */ }
        await delay(150, undefined, { signal });
      }
      throw new Error('SnowLuma 进程已启动，但管理页面在 20 秒内未就绪；请查看终端日志');
    } catch (error) {
      if (signal.aborted) return this.status();
      this.phase = 'error'; this.lastError = String((error as Error).message);
      this.line(this.lastError); this.log.warn({ ...errorDetails(error) }, 'SnowLuma 启动失败');
      throw error;
    }
  }
  get backendUrl() { return `http://127.0.0.1:${this.backendPort}`; }
  async stop() {
    if (this.stopping) return this.stopping;
    this.operation?.abort();
    this.stopping = this.stopChild().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async stopChild() {
    this.phase = 'stopping';
    await this.installation;
    await this.starting?.catch(() => undefined);
    const child = this.child;
    if (child) {
      this.line(`停止受管 SnowLuma 进程 ${child.pid}`);
      const ended = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.stdin.end();
      const timer = setTimeout(() => {
        if (this.child !== child || !child.pid) return;
        if (process.platform === 'win32') {
          void promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
            .catch(error => this.line('停止进程树失败：' + error.message));
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }, 8000);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([ended, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('SnowLuma 受管进程停止超时，请查看进程状态')), 12000);
      })]); } finally { clearTimeout(timer); if (deadline) clearTimeout(deadline); }
    }
    this.phase = this.installed() ? 'stopped' : 'not_installed'; this.backendPort = 0;
  }
  async shutdown() { this.closed = true; await this.stop(); }
}
