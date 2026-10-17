import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { releaseAsset, SNOWLUMA_SOURCE, SNOWLUMA_SOURCE_COMMIT, SNOWLUMA_VERSION } from './release.js';

const execute = promisify(execFile);
export function snowLumaPaths(root: string) {
  const home = path.resolve(root, 'runtime', 'snowluma');
  return { home, distribution: path.join(home, 'distribution'),
    program: path.join(home, 'distribution', 'app'), source: path.join(home, 'distribution', 'source'),
    state: path.join(home, 'state'), downloads: path.join(home, 'downloads') };
}

export function validateArchiveEntries(entries: string[]) {
  if (!entries.length) throw new Error('SnowLuma 压缩包为空');
  for (const entry of entries) {
    const name = entry.replace(/\\/g, '/');
    if (/^(?:\/|[a-z]:)/i.test(name) || name.split('/').includes('..') || name.includes('\0'))
      throw new Error('SnowLuma 压缩包包含非法路径');
  }
}

async function download(asset: { name: string; url: string; sha256: string }, dir: string,
  signal: AbortSignal, report: (text: string) => void) {
  const file = path.join(dir, asset.name);
  const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  try { if (hash(await fs.readFile(file)) === asset.sha256) { report(`使用已验证的缓存：${asset.name}`); return file; } }
  catch { /* 首次安装没有缓存。 */ }
  report(`下载官方文件：${asset.name}`);
  const response = await fetch(asset.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    headers: { 'User-Agent': 'QQ-Agent-SnowLuma' } });
  if (!response.ok || !response.body) throw new Error(`SnowLuma 下载失败：HTTP ${response.status}`);
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try { while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    signal.throwIfAborted(); size += chunk.value.length;
    if (size > 128 * 1024 * 1024) throw new Error('SnowLuma 下载超过 128 MiB 上限');
    chunks.push(chunk.value);
  } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const data = Buffer.concat(chunks);
  if (hash(data) !== asset.sha256) throw new Error(`SnowLuma SHA256 校验失败：${asset.name}`);
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temp, data, { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
  report(`SHA256 校验通过：${asset.name}`);
  return file;
}

async function extract(file: string, destination: string, signal: AbortSignal) {
  await fs.mkdir(destination, { recursive: true });
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const listing = await execute(tar, ['-tf', file], { windowsHide: true, signal, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  validateArchiveEntries(listing.stdout.trim().split(/\r?\n/));
  // 文件来自固定 SHA256 的官方包，不解压外部上传的任意归档。
  if (process.platform === 'win32' && file.endsWith('.zip')) {
    // 源码包中 CLAUDE.md 是符号链接；Windows tar 无权限创建，Expand-Archive 可展开官方 ZIP。
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(file)} -DestinationPath ${quote(destination)}`],
    { windowsHide: true, signal, timeout: 120000 });
  } else await execute(tar, ['-xf', file, '-C', destination], { windowsHide: true, signal, timeout: 120000 });
}

/** 安装目录原子发布；账号配置、缓存、日志始终在独立 state 目录。 */
export async function installSnowLuma(root: string, report: (text: string) => void, signal: AbortSignal) {
  const p = snowLumaPaths(root), asset = releaseAsset();
  await fs.mkdir(p.downloads, { recursive: true });
  if (await fs.stat(p.distribution).then(() => true, () => false)) throw new Error('已存在 SnowLuma 安装目录，不覆盖现有组件');
  const stage = path.join(p.home, 'install-' + randomUUID());
  // 只删除本次生成、位于 SnowLuma home 内的临时目录。
  if (path.dirname(stage) !== p.home) throw new Error('SnowLuma 临时目录归属错误');
  try {
    const programZip = await download(asset, p.downloads, signal, report);
    const sourceZip = await download(SNOWLUMA_SOURCE, p.downloads, signal, report);
    report('解压官方运行包与原始源码');
    await extract(programZip, path.join(stage, 'app'), signal);
    await extract(sourceZip, path.join(stage, 'source'), signal);
    const sourceRoot = path.join(stage, 'source', `SnowLuma-${SNOWLUMA_VERSION}`);
    await fs.access(path.join(stage, 'app', 'index.mjs'));
    await fs.access(path.join(stage, 'app', 'client', 'index.html'));
    await fs.access(path.join(stage, 'app', 'native'));
    await fs.access(path.join(sourceRoot, 'packages', 'core', 'src', 'index.ts'));
    // 官方完整包缺少根 LICENSE 时，额外保留源码中的完整许可，不修改上游代码。
    await fs.copyFile(path.join(sourceRoot, 'LICENSE'), path.join(stage, 'LICENSE'));
    if (process.platform !== 'win32') await fs.chmod(path.join(stage, 'app', 'node'), 0o755);
    await fs.writeFile(path.join(stage, 'installation.json'), JSON.stringify({ version: SNOWLUMA_VERSION,
      sourceCommit: SNOWLUMA_SOURCE_COMMIT, platform: process.platform, arch: process.arch,
      asset: asset.name, sha256: asset.sha256, sourceSha256: SNOWLUMA_SOURCE.sha256 }, null, 2));
    signal.throwIfAborted();
    await fs.rename(stage, p.distribution);
    report(`SnowLuma ${SNOWLUMA_VERSION} 已内置；原始源码和运行数据分别保存`);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
