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

export function redactLog(value: Record<string,unknown>): Record<string,unknown> {
  const walk=(v:unknown,key=''):unknown=>{
    if(/api.?key|authorization|auth.?token|password|secret/i.test(key))return '[REDACTED]';
    if(typeof v==='string')return v.replace(/(?:base64:\/\/|data:[^,]+;base64,)[A-Za-z0-9+/=]+/g,'[IMAGE]').replace(/https?:\/\/[^\s"'<>]+/g,raw=>{try{return new URL(raw).origin+'/[URL]';}catch{return '[URL]';}});
    if(Array.isArray(v))return v.map(x=>walk(x));
    if(v && typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x,k)]));return v;
  };
  return walk(value) as Record<string,unknown>;
}
export async function flushLogger():Promise<void> {if(fileStream)await new Promise<void>((resolve,reject)=>fileStream!.write('',error=>error?reject(error):resolve()));}
