/**
 * 日志系统（pino）
 * 开发模式彩色可读，生产模式 JSON；同时按天落盘到 logs/。
 */
import fs from 'node:fs';
import path from 'node:path';
import {Writable} from 'node:stream';
import pino, { type Logger } from 'pino';

let fileStream: Writable | undefined;
let rootLogger: Logger | null = null;

export interface LoggerInitOptions {
  level: string;
  pretty: boolean;
  logDir: string;
}

export function initLogger(opts: LoggerInitOptions): Logger {
  fs.mkdirSync(opts.logDir, { recursive: true });
  const fileDestination = new Writable({write(chunk,_encoding,done) {
    const date=new Date().toISOString().slice(0,10);
    const cutoff=Date.now()-14*86400000;
    for(const name of fs.readdirSync(opts.logDir)){
      const match=/^agent-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if(match && Date.parse(match[1]!)<cutoff) {try{fs.unlinkSync(path.join(opts.logDir,name));}catch{}}
    }
    fs.appendFile(path.join(opts.logDir,'agent-'+date+'.log'),chunk,done);
  }});
  fileStream=fileDestination;

  const streams: pino.StreamEntry[] = [
    { level: opts.level as pino.Level, stream: fileDestination },
  ];

  if (opts.pretty) {
    streams.push({
      level: opts.level as pino.Level,
      stream: pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
          messageFormat: '{msg}',
        },
      }),
    });
  } else {
    streams.push({ level: opts.level as pino.Level, stream: process.stdout });
  }

  rootLogger = pino({ level: opts.level, formatters: {log: redactLog} }, pino.multistream(streams));
  return rootLogger;
}

/** 获取 logger；未初始化时回退到控制台，保证任何阶段都能打日志 */
export function getLogger(name?: string): Logger {
  if (!rootLogger) {
    rootLogger = pino({ level: process.env.LOG_LEVEL ?? 'info', formatters: {log:redactLog} });
  }
  return name ? rootLogger.child({ mod: name }) : rootLogger;
}

export type { Logger };

/** 有界错误快照：不枚举响应正文/请求配置，不修改或重新抛出原异常。 */
export function errorDetails(value: unknown): { errorKind: string; error: Record<string, unknown> } {
  const seen = new Set<unknown>();
  const snapshot = (item: unknown, depth = 0): Record<string, unknown> => {
    if (depth >= 4 || seen.has(item)) return { message: '[CAUSE TRUNCATED]' };
    if (!item || typeof item !== 'object') return { name: 'NonError', message: typeof item === 'string' ? item.slice(0, 2000) : String(item) };
    seen.add(item);
    const out: Record<string, unknown> = {};
    for (const key of ['name', 'message', 'stack', 'code', 'status', 'statusCode', 'errno', 'syscall', 'action', 'retcode', 'outcome', 'retriable', 'cancelled']) {
      try {
        const field = (item as Record<string, unknown>)[key];
        if (typeof field === 'string') out[key] = key === 'stack' ? field.split('\n').slice(0, 12).join('\n').slice(0, 4000) : field.slice(0, 2000);
        else if (typeof field === 'boolean' || typeof field === 'number') out[key] = field;
      } catch { /* 不可信 getter 不得影响错误处理 */ }
    }
    try {
      const cause = (item as { cause?: unknown }).cause;
      if (cause !== undefined) out.cause = snapshot(cause, depth + 1);
      if (item instanceof AggregateError) out.errors = item.errors.slice(0, 5).map(e => snapshot(e, depth + 1));
    } catch { /* 错误诊断不可改变回退行为 */ }
    return Object.keys(out).length ? out : { name: 'UnknownError', message: '未提供错误信息' };
  };
  const error = snapshot(value);
  const clues = [error.name, error.code, error.message, JSON.stringify(error.cause ?? '')].join(' ');
  const errorKind = /timeout|timed?\s*out|ETIMEDOUT|时间预算|超时/i.test(clues) ? 'timeout'
    : error.cancelled || /AbortError|cancelled|canceled|请求已取消/i.test(clues) ? 'cancelled'
    : [401, 403].includes(Number(error.status ?? error.statusCode)) ? 'authentication'
    : Number(error.status ?? error.statusCode) === 429 ? 'rate-limit'
    : /ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket/i.test(clues) ? 'network'
    : /SyntaxError|JSON|格式|字段|数量.*匹配/i.test(clues) ? 'invalid-response'
    : 'error';
  return redactLog({ errorKind, error }) as { errorKind: string; error: Record<string, unknown> };
}

export function redactLog(value: Record<string,unknown>): Record<string,unknown> {
  const seen = new WeakSet<object>();
  const walk=(v:unknown,key='',depth=0):unknown=>{
    if(/api.?key|authorization|auth.?token|access.?token|password|secret|cookie/i.test(key))return '[REDACTED]';
    if(typeof v==='string')return v.replace(/(?:base64:\/\/|data:[^,]+;base64,)[A-Za-z0-9+/=]+/g,'[IMAGE]')
      .replace(/\bBearer\s+[^\s,"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[a-z0-9_-]+/gi, '[REDACTED]')
      .replace(/((?:api[_-]?key|authorization|auth[_-]?token|access[_-]?token|password|secret|cookie)["']?\s*[:=]\s*["']?)[^\s,"'<>]+/gi, '$1[REDACTED]')
      .replace(/https?:\/\/[^\s"'<>]+/g,raw=>{try{return new URL(raw).origin+'/[URL]';}catch{return '[URL]';}});
    if(v && typeof v==='object') {
      if (depth >= 8 || seen.has(v)) return '[TRUNCATED]';
      seen.add(v);
      try {
        if (v instanceof Error) return walk(errorDetails(v).error, key, depth + 1);
        if(Array.isArray(v))return v.map(x=>walk(x,'',depth+1));
        return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x,k,depth+1)]));
      } catch { return '[UNAVAILABLE]'; }
      finally { seen.delete(v); }
    }
    return v;
  };
  return walk(value) as Record<string,unknown>;
}
export async function flushLogger():Promise<void> {if(fileStream)await new Promise<void>((resolve,reject)=>fileStream!.write('',error=>error?reject(error):resolve()));}
