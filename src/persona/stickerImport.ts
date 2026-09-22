/**
 * QQ 收藏表情导入
 *
 * NapCat 提供 `fetch_custom_face`（返回收藏表情的图片 URL 列表）和
 * `fetch_custom_face_detail`（额外给 resId / md5 / desc）。
 *
 * **为什么必须下载到本地**：这些 URL 是腾讯 CDN 的临时地址，带签名且会过期。
 * 直接存 URL 过一阵就全是死链，所以导入 = 拉列表 + 立刻下载落盘。
 *
 * 文件名用 `qq_<md5前12位>.<ext>`：稳定、可预测，
 * 于是重复导入天然幂等（同一张图永远算出同一个文件名），不会堆一堆副本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Logger } from '../core/logger.js';
import type { StickerEntry, QqFavEmoji } from '../core/types.js';
import { sniffMime } from '../llm/vision.js';
import { isImageFile, QQ_SUBDIR, type StickerLibrary } from './stickers.js';

/** 单张下载大小上限 */
const MAX_BYTES = 8 * 1024 * 1024;
/** 单次导入最多拉几张，防止一次性把磁盘塞满 */
export const MAX_IMPORT = 500;

export interface ImportResult {
  /** 拉到的收藏表情总数 */
  fetched: number;
  /** 新下载的 */
  added: number;
  /** 已存在（按 md5 去重）跳过的 */
  skipped: number;
  /** 下载/解析失败的 */
  failed: number;
  errors: string[];
  /** 新增的文件相对路径 */
  files: string[];
}

export interface ImportOptions {
  /** 拉取数量上限 */
  limit?: number;
  /** 已有条目里出现过的 md5，用来跳过 */
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** MIME → 扩展名（下载回来的图不一定有正确后缀） */
function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/bmp':
      return '.bmp';
    default:
      return '.jpg';
  }
}

/** 从 URL 路径猜扩展名，猜不到就空串 */
function extFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname;
    const e = path.extname(p).toLowerCase();
    return isImageFile(`x${e}`) ? e : '';
  } catch {
    return '';
  }
}

async function download(url: string, timeoutMs = 20000): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      // 腾讯 CDN 对空 UA 有时会拒绝
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * 从 QQ 账号导入收藏表情。
 *
 * 优先用 `fetch_custom_face_detail`（能拿到 md5，去重更准）；
 * 该动作不存在或返回空时退化成 `fetch_custom_face`（只有 URL，用 URL 的哈希当身份）。
 */
export async function importQqFavorites(
  api: {
    fetchCustomFaceDetail?: (count: number) => Promise<QqFavEmoji[]>;
    fetchCustomFace?: (count: number) => Promise<string[]>;
  },
  lib: StickerLibrary,
  log: Logger,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const limit = Math.min(opts.limit ?? 48, MAX_IMPORT);
  const out: ImportResult = {
    fetched: 0,
    added: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    files: [],
  };

  // ---- 1. 拉列表：先试详情，退化到只要 URL ----
  let items: QqFavEmoji[] = [];
  try {
    if (api.fetchCustomFaceDetail) {
      items = (await api.fetchCustomFaceDetail(limit)).filter((e) => e.url);
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'fetch_custom_face_detail 不可用，退化为 fetch_custom_face');
  }

  if (items.length === 0 && api.fetchCustomFace) {
    try {
      const urls = await api.fetchCustomFace(limit);
      items = urls.map((url) => ({ url, resId: '', md5: '', emojiId: '', desc: '' }));
    } catch (e) {
      const msg = (e as Error).message;
      out.errors.push(
        /unsupported|unknown action|不支持的?action/i.test(msg)
          ? '当前 NapCat 版本不支持读取收藏表情（需要含 fetch_custom_face 扩展动作的版本）'
          : `读取收藏表情失败：${msg}`,
      );
      log.warn({ err: msg }, '读取 QQ 收藏表情失败');
      return out;
    }
  }

  out.fetched = items.length;
  if (items.length === 0) {
    out.errors.push('收藏表情为空，或 NapCat 未返回任何条目');
    return out;
  }

  // ---- 2. 去重表：已导入过的 md5 / resId ----
  const knownMd5 = new Set<string>();
  const knownRes = new Set<string>();
  for (const s of lib.list()) {
    if (s.md5) knownMd5.add(s.md5.toLowerCase());
    if (s.resId) knownRes.add(s.resId);
  }

  // ---- 3. 逐张下载 ----
  const dir = path.join(lib.root, QQ_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });

  const newEntries: StickerEntry[] = [];
  let done = 0;

  for (const item of items) {
    done++;
    opts.onProgress?.(done, items.length);
    if (opts.signal?.aborted) break;

    // 已导入过的直接跳过
    const itemMd5 = item.md5.toLowerCase();
    if ((itemMd5 && knownMd5.has(itemMd5)) || (item.resId && knownRes.has(item.resId))) {
      out.skipped++;
      continue;
    }

    try {
      const buf = await download(item.url);
      if (buf.length === 0) throw new Error('内容为空');
      if (buf.length > MAX_BYTES) throw new Error(`过大 ${(buf.length / 1024 / 1024).toFixed(1)}MB`);

      // 身份：优先用 NapCat 给的 md5，否则自己算 URL 的哈希
      const md5 = itemMd5 || createHash('md5').update(buf).digest('hex');
      if (knownMd5.has(md5)) {
        out.skipped++;
        continue;
      }

      const mime = sniffMime(buf);
      // URL 后缀通常是对的，优先用；没有就按魔数猜
      const ext = extFromUrl(item.url) || extFromMime(mime);
      const rel = `${QQ_SUBDIR}/qq_${md5.slice(0, 12)}${ext}`;
      const abs = path.join(lib.root, rel);

      // 文件已存在（上次导入过但 manifest 被删了）：补 manifest 记录即可
      if (!fs.existsSync(abs)) {
        fs.writeFileSync(abs, buf);
      }

      knownMd5.add(md5);
      if (item.resId) knownRes.add(item.resId);

      newEntries.push({
        file: rel,
        // QQ 那边自带的表情描述有时是空的；有就先用上，AI 识别会再覆盖
        tags: [],
        desc: item.desc ?? '',
        useWhen: '',
        emotions: [],
        source: 'qq',
        resId: item.resId,
        md5,
        emojiId: item.emojiId,
        url: item.url,
      });
      out.files.push(rel);
      out.added++;
    } catch (e) {
      out.failed++;
      const msg = `${item.url.slice(0, 50)}: ${(e as Error).message}`;
      if (out.errors.length < 10) out.errors.push(msg);
      log.debug({ err: (e as Error).message }, '下载收藏表情失败');
    }
  }

  // ---- 4. 一次性写 manifest 并重载 ----
  if (newEntries.length > 0) {
    lib.upsert(newEntries);
  }

  log.info(
    { fetched: out.fetched, added: out.added, skipped: out.skipped, failed: out.failed },
    `QQ 收藏表情导入完成：新增 ${out.added}，跳过 ${out.skipped}，失败 ${out.failed}`,
  );
  return out;
}

/**
 * 把 AI 写出来的描述回写进 QQ 自带的收藏表情描述。
 * 需要在导入时拿到 resId/md5/emojiId —— 缺一不可，所以只能对 qq 来源的条目做。
 */
export async function pushDescToQq(
  api: { setCustomFaceDesc?: (i: { emojiId: string; resId: string; md5: string; desc: string }) => Promise<unknown> },
  entries: Array<{ emojiId?: string; resId?: string; md5?: string; desc: string }>,
  log: Logger,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  if (!api.setCustomFaceDesc) return { ok, failed };

  for (const e of entries) {
    if (!e.resId || !e.md5 || !e.desc) {
      failed++;
      continue;
    }
    try {
      await api.setCustomFaceDesc({
        emojiId: e.emojiId ?? '0',
        resId: e.resId,
        md5: e.md5,
        desc: e.desc.slice(0, 60),
      });
      ok++;
    } catch (err) {
      failed++;
      log.debug({ err: (err as Error).message }, '回写收藏表情描述失败');
    }
  }
  return { ok, failed };
}
