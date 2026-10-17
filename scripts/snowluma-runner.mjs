// 同进程加载原样官方入口，仍与 Agent 分进程。父进程退出时 stdin EOF 触发收尾。
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
if (!process.argv[2]) throw new Error('缺少 SnowLuma 官方程序入口');
const entryPath = resolve(process.argv[2]);
// 上游用 argv[1] 创建数据库迁移 Worker，必须指向官方入口；保留其余 CLI 参数。
process.argv.splice(1, 2, entryPath);
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
  else process.exit(0);
  const timer = setTimeout(() => process.exit(1), 10000);
  timer.unref();
}
process.stdin.resume();
process.stdin.on('end', close);
process.stdin.on('error', close);
// Ctrl-C / stdin 都由本地包装层收尾；不运行系统 Shell 命令。
process.stdin.on('data', data => { if (data.includes(3)) close(); });
await import(pathToFileURL(entryPath).href);
