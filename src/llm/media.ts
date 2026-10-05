import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { CollectedImage } from './vision.js';

export interface MediaOptions {
  timeoutMs?: number; maxImages?: number; maxBytes?: number; maxDimension?: number; maxPixels?: number;
  allowedDirs?: string[]; signal?: AbortSignal;
  getImage?: (file: string) => Promise<{ file?: string; url?: string }>;
  onImage?: (image: CollectedImage, index: number) => void;
}
const cache = new Map<string, { image: CollectedImage; at: number; bytes: number }>();
let cacheBytes = 0;
let active = 0; const waiting: (() => void)[] = [];
async function permit(): Promise<() => void> {
  if (waiting.length >= 128) throw new Error('图片处理队列已满');
  if (active >= 2) await new Promise<void>(r => waiting.push(r)); else active++;
  return () => { const next = waiting.shift(); if (next) next(); else active--; };
}
async function readUrl(url: string, opts: MediaOptions): Promise<Buffer> {
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 15000)]) : AbortSignal.timeout(opts.timeoutMs ?? 15000);
  const res = await fetch(url, { signal }); if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const max = opts.maxBytes ?? 8 * 1024 * 1024;
  if (Number(res.headers.get('content-length')) > max) { await res.body?.cancel(); throw new Error('图片超过下载字节上限'); }
  const reader = res.body?.getReader(); if (!reader) throw new Error('图片响应无正文');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > max) throw new Error('图片超过下载字节上限'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, bytes);
}
export async function readSource(source: string, opts: MediaOptions): Promise<Buffer> {
  const max = opts.maxBytes ?? 8 * 1024 * 1024;
  if (source.startsWith('base64://')) {
    if (source.length > Math.ceil(max * 4 / 3) + 32) throw new Error('内嵌图片超过字节上限');
    const encoded = source.slice(9); if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('图片 base64 无效');
    return Buffer.from(encoded, 'base64');
  }
  if (/^https?:\/\//i.test(source)) return readUrl(source, opts);
  const target = await fs.realpath(path.resolve(source));
  let allowed = false;
  for (const dir of opts.allowedDirs ?? []) {
    const root = await fs.realpath(path.resolve(dir)).catch(() => ''); if (!root) continue;
    const relative = path.relative(root, target); if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) allowed = true;
  }
  if (!allowed) throw new Error('图片路径不在允许的媒体目录');
  const handle = await fs.open(target, 'r');
  try { const info = await handle.stat(); if (!info.isFile() || info.size > max) throw new Error('本地图片超过上限或不是文件');
    const buffer = Buffer.alloc(max + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) throw new Error('本地图片超过字节上限'); return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
export async function loadMedia(file: string, url: string, opts: MediaOptions): Promise<CollectedImage> {
  const key = createHash('sha256').update(JSON.stringify([file, url, opts.maxDimension, opts.maxBytes, opts.maxPixels, opts.allowedDirs])).digest('hex');
  const cached = cache.get(key); if (cached && Date.now() - cached.at < 600000) return structuredClone(cached.image);
  const release = await permit();
  try {
    opts.signal?.throwIfAborted(); let bytes: Buffer | undefined;
    for (const source of [file.startsWith('base64://') ? file : '', url, file].filter(Boolean)) {
      try { bytes = await readSource(source, opts); break; } catch { opts.signal?.throwIfAborted(); }
    }
    if (!bytes && opts.getImage && file) {
      const recovered = await opts.getImage(file);
      for (const source of [recovered.url, recovered.file].filter(Boolean) as string[]) {
        try { bytes = await readSource(source, opts); break; } catch { opts.signal?.throwIfAborted(); }
      }
    }
    if (!bytes) throw new Error('无法获取图片，URL 失效或路径不被允许');
    if (!bytes.length || bytes.length > (opts.maxBytes ?? 8 * 1024 * 1024)) throw new Error('图片为空或超过字节上限');
    const image = sharp(bytes, { limitInputPixels: opts.maxPixels ?? 40000000, pages: 1, failOn: 'warning' });
    const meta = await image.metadata();
    if (!['png', 'jpeg', 'webp', 'gif', 'avif'].includes(meta.format ?? '') || !meta.width || !meta.height) throw new Error('不支持的图片真实格式');
    const { data, info } = await image.rotate().resize({ width: opts.maxDimension ?? 2048, height: opts.maxDimension ?? 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    if (data.length > (opts.maxBytes ?? 8 * 1024 * 1024)) throw new Error('处理后的图片超过字节上限');
    opts.signal?.throwIfAborted();
    const result: CollectedImage = { part: { type: 'image', mimeType: 'image/png', data: data.toString('base64'), width: info.width, height: info.height }, source: 'media',
      hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, width: info.width, height: info.height, frames: meta.pages ?? 1 };
    const size = data.length; if (size <= 32 * 1024 * 1024) {
      while (cache.size && (cache.size >= 128 || cacheBytes + size > 32 * 1024 * 1024)) {
        const oldest = cache.keys().next().value!; cacheBytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
      }
      const previous = cache.get(key); if (previous) cacheBytes -= previous.bytes;
      cache.set(key, { image: result, at: Date.now(), bytes: size }); cacheBytes += size;
    }
    return structuredClone(result);
  } finally { release(); }
}
