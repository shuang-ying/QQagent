/**
 * 日志系统（pino）
 * 开发模式彩色可读，生产模式 JSON；同时按天落盘到 logs/。
 */
import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

let rootLogger: Logger | null = null;

export interface LoggerInitOptions {
  level: string;
  pretty: boolean;
  logDir: string;
}

export function initLogger(opts: LoggerInitOptions): Logger {
  fs.mkdirSync(opts.logDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  // 用 pino.destination 显式指定 utf8 编码，
  // 否则 Windows 下默认按系统 ANSI 写盘，中文会变乱码
  const fileDestination = pino.destination({
    dest: path.join(opts.logDir, `agent-${date}.log`),
    mkdir: true,
    sync: false,
  });

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

  rootLogger = pino({ level: opts.level }, pino.multistream(streams));
  return rootLogger;
}

/** 获取 logger；未初始化时回退到控制台，保证任何阶段都能打日志 */
export function getLogger(name?: string): Logger {
  if (!rootLogger) {
    rootLogger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  }
  return name ? rootLogger.child({ mod: name }) : rootLogger;
}

export type { Logger };
