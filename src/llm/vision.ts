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
import { loadMedia, type MediaOptions } from './media.js';

import type { ContentPart, ObMessageSegment } from '../core/types.js';

/** 单张图上限（base64 前的原始字节） */

/** 单条消息最多处理几张图 */
export const MAX_IMAGES_PER_MESSAGE = 3;

/** 常见图片扩展名 → MIME */


/** 按魔数猜 MIME（比扩展名可靠） */
export function sniffMime(buf: Buffer): string {
  if (buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return '';
}

export interface CollectedImage {
  hash?: string; bytes?: number; width?: number; height?: number; frames?: number;
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
export async function collectImages(segments: ObMessageSegment[], opts: MediaOptions = {}): Promise<CollectResult> {
  const images: CollectedImage[] = []; const errors: string[] = [];
  const segs = segments.filter(isImageSegment).slice(0, opts.maxImages ?? MAX_IMAGES_PER_MESSAGE);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    try {
      const image = await loadMedia(String(seg.data['file'] ?? ''), String(seg.data['url'] ?? ''), opts);
      images.push(image); opts.onImage?.(image, i);
    } catch (error) { errors.push('读取图片失败：' + (error as Error).message); }
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
  rowId?: number; userId?: number; messageId?: number;
  /** messages.raw_segments 原文 */
  rawSegments: string | null;
  senderName: string;
  createdAt: number;
}

export interface HistoryImageResult {
  sourceRowIds?: number[];
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
  opts: MediaOptions & { onSourceImage?: (image: CollectedImage, index: number, source: HistoricalImageSource) => void } = {},
): Promise<HistoryImageResult> {
  const images: Array<ContentPart & { type: 'image' }> = [];
  const notes: string[] = [];
  const sourceRowIds: number[] = [];
  const errors: string[] = [];

  if (maxImages <= 0) return { images, notes, errors, sourceRowIds };

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
    const got = await collectImages(segments, { ...opts, maxImages: room, onImage: (image, index) => opts.onSourceImage?.(image, index, src) });
    if (got.errors.length > 0) errors.push(...got.errors.map(error => `${src.senderName || '某人'}（QQ ${src.userId ?? '-'}；msg ${src.messageId ?? '-'}）：${error}`));
    if (got.images.length === 0) continue;

    images.unshift(...got.images.map(img => img.part));
    sourceRowIds.unshift(...got.images.map(() => src.rowId ?? 0));
    notes.unshift(...got.images.map(() => `${src.senderName || '某人'}${src.userId ? `（QQ ${src.userId}）` : ''} 发的图（msg ${src.messageId ?? '-'}；${relativeTime(src.createdAt)}）`));
  }

  // 刚才是从新到旧，翻回正序
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
