/**
 * 图片消息处理
 *
 * OneBot 的图片段长这样（NapCat 会给出 url / file 中的一个或两个）：
 *   { type: 'image', data: { file: 'xxx.jpg', url: 'http://…', file_size: '12345' } }
 *
 * 各家大模型的图片入参形式不同，但都接受 base64。这里统一解析成 base64，
 * 由协议适配器再转成各自需要的形状（image_url / inline_data / images 等）。
 *
 * 为什么要本地取图而不是把 URL 直接丢给模型：
 * NapCat 给的 url 常常是内网地址或临时文件，模型侧的服务器根本访问不到。
 * 本地取回来再以 base64 发送，可靠性高得多。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ContentPart, ObMessageSegment } from '../core/types.js';

/** 单张图上限（base64 前的原始字节） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 单条消息最多处理几张图 */
export const MAX_IMAGES_PER_MESSAGE = 3;

/** 常见图片扩展名 → MIME */
const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 按魔数猜 MIME（比扩展名可靠） */
export function sniffMime(buf: Buffer): string {
  if (buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}

function mimeFromName(name: string): string | undefined {
  return EXT_MIME[path.extname(name).toLowerCase()];
}

/** 判断是不是"看起来像 URL" */
function isHttp(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

async function fetchBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export interface CollectedImage {
  part: ContentPart & { type: 'image' };
  /** 来源描述，便于日志排查 */
  source: string;
}

export interface CollectResult {
  images: CollectedImage[];
  /** 取图失败的原因（用于给用户/日志一个说法） */
  errors: string[];
}

/**
 * 从消息段里取出图片并解析成 base64。
 *
 * 解析优先级：base64:// > http(s) url > 本地文件路径。
 * 失败不抛异常，记在 errors 里，主流程照常走（退化成 [图片] 占位符）。
 */
export async function collectImages(
  segments: ObMessageSegment[],
  opts: { timeoutMs?: number; maxImages?: number } = {},
): Promise<CollectResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxImages = opts.maxImages ?? MAX_IMAGES_PER_MESSAGE;

  const images: CollectedImage[] = [];
  const errors: string[] = [];

  const segs = segments.filter(isImageSegment).slice(0, maxImages);

  for (const seg of segs) {
    const d = seg.data ?? {};
    const file = String(d['file'] ?? '');
    const url = String(d['url'] ?? '');
    const summary = String(d['summary'] ?? '');
    void summary;

    try {
      let buf: Buffer | null = null;
      let source = '';

      // 1) base64:// 直接内嵌
      if (file.startsWith('base64://')) {
        buf = Buffer.from(file.slice('base64://'.length), 'base64');
        source = 'inline-base64';
      }

      // 2) 明确的 http(s) 地址
      if (!buf && isHttp(url)) {
        buf = await fetchBytes(url, timeoutMs);
        source = `url:${url.slice(0, 60)}`;
      }
      if (!buf && isHttp(file)) {
        buf = await fetchBytes(file, timeoutMs);
        source = `file-url:${file.slice(0, 60)}`;
      }

      // 3) 本地路径
      if (!buf && file && !file.startsWith('base64://')) {
        const p = path.isAbsolute(file) ? file : path.resolve(file);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          buf = fs.readFileSync(p);
          source = `path:${p}`;
        }
      }

      if (!buf) {
        errors.push(file || url ? '无法读取图片（既不是有效 URL 也不是可读文件）' : '图片段缺少 file/url');
        continue;
      }

      // 有些实现会给 base64 字符串，但没加前缀 —— 兜底识别
      if (buf.length < 32 && /^[A-Za-z0-9+/=]{32,}$/.test(buf.toString('utf8'))) {
        buf = Buffer.from(buf.toString('utf8'), 'base64');
        source = 'raw-base64';
      }

      if (buf.length > MAX_IMAGE_BYTES) {
        errors.push(`图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB > 8MB）`);
        continue;
      }
      if (buf.length === 0) {
        errors.push('图片内容为空');
        continue;
      }

      const mimeType = sniffMime(buf) || mimeFromName(file) || 'image/jpeg';
      images.push({ part: { type: 'image', mimeType, data: buf.toString('base64') }, source });
    } catch (e) {
      errors.push(`读取图片失败：${(e as Error).message}`);
    }
  }

  return { images, errors };
}

/**
 * 这个段里有没有可以取到的图片。
 *
 * 除了标准的 `image`，QQ 的**商城表情 / 收藏表情**有时会以 `mface` 段发来，
 * 只要它带了 url 或 file，同样能拿到画面 —— 不认它的话，
 * 群里发的表情包对模型就是完全不可见的。
 */
export function isImageSegment(seg: ObMessageSegment): boolean {
  if (seg.type === 'image') return true;
  if (seg.type === 'mface') {
    const d = seg.data ?? {};
    return Boolean(d['url'] || d['file']);
  }
  return false;
}

/** 消息里是否有图片 */
export function hasImages(segments: ObMessageSegment[]): boolean {
  return segments.some(isImageSegment);
}

/** 历史图片的来源 */
export interface HistoricalImageSource {
  /** messages.raw_segments 原文 */
  rawSegments: string | null;
  senderName: string;
  createdAt: number;
}

export interface HistoryImageResult {
  images: Array<ContentPart & { type: 'image' }>;
  /** 与 images 一一对应的来源说明 */
  notes: string[];
  errors: string[];
}

/**
 * 从**历史消息**里捞图片。
 *
 * 为什么要这个：主动搭话是"攒够 N 条消息才开口"，那 N 条里别人发的图
 * 在上下文里只剩 `[图片]` / `[表情包]` 这种占位文字，模型看不到画面本身，
 * 于是会答非所问。这里把原始消息段还原出来重新取图。
 *
 * 取图顺序：**从最近往前**。攒了 8 条但只带 3 张时，
 * 显然该带最新的 3 张。取完翻回时间正序，让清单顺序和聊天顺序一致。
 */
export async function collectImagesFromHistory(
  sources: HistoricalImageSource[],
  maxImages: number,
  opts: { timeoutMs?: number } = {},
): Promise<HistoryImageResult> {
  const images: Array<ContentPart & { type: 'image' }> = [];
  const notes: string[] = [];
  const errors: string[] = [];

  if (maxImages <= 0) return { images, notes, errors };

  for (let i = sources.length - 1; i >= 0 && images.length < maxImages; i--) {
    const src = sources[i]!;
    let segments: ObMessageSegment[];
    try {
      segments = src.rawSegments ? (JSON.parse(src.rawSegments) as ObMessageSegment[]) : [];
    } catch {
      continue;
    }
    if (!Array.isArray(segments) || !hasImages(segments)) continue;

    // 单条消息内也限量，避免一条里的 9 张图把预算吃光
    const room = maxImages - images.length;
    const got = await collectImages(segments, { maxImages: room, ...opts });
    if (got.errors.length > 0) errors.push(...got.errors);
    if (got.images.length === 0) continue;

    for (const img of got.images) {
      images.push(img.part);
      notes.push(`${src.senderName || '某人'} 发的图（${relativeTime(src.createdAt)}）`);
    }
  }

  // 刚才是从新到旧，翻回正序
  images.reverse();
  notes.reverse();
  return { images, notes, errors };
}

/**
 * 把时间戳说成"多久之前"。
 * 写绝对时间模型没有时间感；写"2 分钟前"它才能判断这张图是不是当前话题的一部分。
 */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (!Number.isFinite(diff) || diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}
