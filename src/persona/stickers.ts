/**
 * 表情包库
 *
 * 两层信息：
 *   1. **文件**：目录里的图片。文件名给一个初始标签（happy_01.png → happy）。
 *   2. **manifest**（`manifest.json`）：每张图的标签、AI 看图写出的描述与适用情境、
 *      适合的情绪、以及（从 QQ 收藏导入时的）resId/md5 等来源信息。
 *
 * 为什么需要 manifest：文件名只能表达"这是什么表情"，
 * 但"该在什么情境下发"是语义判断，得让模型看图后自己写下来。
 * 有了这层描述，才能在提示词里告诉模型"这张图适合用在什么时候"，
 * 也才能在没有模型主动指定的情况下按情绪自动补一张对的图。
 *
 * 模型在回复里用 `[表情:标签]` 表示"这里想发张图"，
 * 分发器把标记从文本里摘掉，再真的把图片发出去。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import {
  StickerManifestSchema,
  type StickerEntry,
  type StickerManifest,
} from '../core/types.js';

/** 支持的图片扩展名 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** 模型用来表达"发个表情"的标记，如 [表情:happy] */
export const STICKER_MARKER_RE = /\[\s*表情\s*[:：]\s*([^\]\s]+)\s*\]/g;

/**
 * 从 QQ 收藏导入的子目录名。
 * 放在这里而不是 stickerImport.ts，是为了让库能识别"这个文件的文件名是哈希、不能当标签"，
 * 同时避免 stickerImport ↔ stickers 的循环依赖。
 */
export const QQ_SUBDIR = 'qq';

/** 面板/提示词用的条目视图 */
export interface StickerView extends StickerEntry {
  /** 绝对路径 */
  absPath: string;
  /** 字节数 */
  size: number;
  /** 文件缺失（manifest 里有记录但文件没了） */
  missing: boolean;
}

export class StickerLibrary {
  /** 标签 → 条目 */
  private byTag = new Map<string, StickerView[]>();
  private all: StickerView[] = [];
  /** 相对路径 → 条目 */
  private byRel = new Map<string, StickerView>();

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    private readonly manifestName = 'manifest.json',
  ) {
    this.reload();
  }

  private get manifestPath(): string {
    return path.join(this.dir, this.manifestName);
  }

  /**
   * 重新扫描目录 + 读 manifest。
   *
   * 关键规则：**manifest 记录为准，文件名只作缺省**。
   * 这样 AI 识别出来的标签不会被文件名覆盖掉，也允许面板改标签。
   */
  reload(): number {
    this.byTag.clear();
    this.all = [];
    this.byRel.clear();

    let manifest: StickerManifest = { version: 1, entries: [] };
    try {
      if (fs.existsSync(this.manifestPath)) {
        const raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
        const parsed = StickerManifestSchema.safeParse(raw);
        if (parsed.success) {
          manifest = parsed.data;
        } else {
          this.log.warn({ err: parsed.error.issues[0]?.message }, 'manifest.json 格式不对，已忽略');
        }
      }
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, '读取表情包 manifest 失败，按文件名重建');
    }

    const metaByRel = new Map<string, StickerEntry>();
    for (const e of manifest.entries) {
      metaByRel.set(normalizeRel(e.file), e);
    }

    try {
      if (!fs.existsSync(this.dir)) return 0;

      for (const rel of walkImages(this.dir)) {
        const abs = path.join(this.dir, rel);
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }

        const meta = metaByRel.get(rel);
        // qq/ 子目录里的文件名是 qq_<md5>，当标签毫无意义 —— 只信 manifest 里的标签。
        // 没识别过就保持无标签（仍可被按情绪挑中），总好过让模型写出 [表情:qq_deadbeef]。
        const fromQqDir = rel.startsWith(`${QQ_SUBDIR}/`);
        const nameTag = fromQqDir ? '' : tagFromFilename(path.basename(rel));
        const tags = (meta?.tags?.length ? meta.tags : nameTag ? [nameTag] : []).filter(Boolean);

        const view: StickerView = {
          file: rel,
          tags,
          desc: meta?.desc ?? '',
          useWhen: meta?.useWhen ?? '',
          emotions: meta?.emotions ?? [],
          source: meta?.source ?? 'local',
          ...(meta?.resId ? { resId: meta.resId } : {}),
          ...(meta?.md5 ? { md5: meta.md5 } : {}),
          ...(meta?.emojiId ? { emojiId: meta.emojiId } : {}),
          ...(meta?.url ? { url: meta.url } : {}),
          ...(meta?.analyzedAt !== undefined ? { analyzedAt: meta.analyzedAt } : {}),
          ...(meta?.analyzedBy ? { analyzedBy: meta.analyzedBy } : {}),
          absPath: abs,
          size: st.size,
          missing: false,
        };

        this.byRel.set(rel, view);
        this.all.push(view);
        for (const t of view.tags) {
          const list = this.byTag.get(t) ?? [];
          list.push(view);
          this.byTag.set(t, list);
        }
      }

      // manifest 里有、但文件已不在的：保留元数据以便面板显示"缺失"，不参与发送
      for (const [rel, meta] of metaByRel) {
        if (this.byRel.has(rel)) continue;
        const view: StickerView = {
          ...meta,
          absPath: path.join(this.dir, rel),
          size: 0,
          missing: true,
        };
        this.byRel.set(rel, view);
        this.all.push(view);
      }
    } catch (e) {
      this.log.warn({ dir: this.dir, err: (e as Error).message }, '扫描表情包目录失败');
    }

    const usable = this.all.filter((s) => !s.missing);
    if (usable.length > 0) {
      this.log.info(
        { dir: this.dir, files: usable.length, tags: this.byTag.size },
        `已加载 ${usable.length} 张表情包`,
      );
    }

    // manifest 缺条目时顺手补全，省得用户手动点一次
    if (this.dirtyOnLoad(manifest)) {
      try {
        this.syncManifest();
      } catch (e) {
        this.log.debug({ err: (e as Error).message }, '自动补全 manifest 失败（不影响运行）');
      }
    }

    return usable.length;
  }

  /** 目录里出现了 manifest 没记过的文件时，需要回写 */
  private dirtyOnLoad(manifest: StickerManifest): boolean {
    const known = new Set(manifest.entries.map((e) => normalizeRel(e.file)));
    return this.all.some((s) => !s.missing && !known.has(s.file));
  }

  /** 是否可用（至少有一张能发的图） */
  get available(): boolean {
    return this.all.some((s) => !s.missing);
  }

  /** 可用的条目（文件存在） */
  usable(): StickerView[] {
    return this.all.filter((s) => !s.missing);
  }

  /** 所有标签（只统计可用条目） */
  tags(): string[] {
    return [...this.byTag.keys()].sort();
  }

  /** 某标签下有几张可用的 */
  countOf(tag: string): number {
    return (this.byTag.get(tag) ?? []).filter((s) => !s.missing).length;
  }

  /** 全部条目（含缺失，面板用） */
  list(): StickerView[] {
    return [...this.all];
  }

  /** 按相对路径取 */
  get(rel: string): StickerView | undefined {
    return this.byRel.get(normalizeRel(rel));
  }

  /** 被 AI 理解过的条目（有 desc） */
  understood(): StickerView[] {
    return this.usable().filter((s) => s.desc.trim().length > 0);
  }

  /** 还没被 AI 看过的条目 */
  pending(): StickerView[] {
    return this.usable().filter((s) => !s.desc.trim());
  }

  /**
   * 按标签随机取一张。标签不存在时返回 undefined。
   * 大小写不敏感；也允许模糊匹配（模型可能把 happy 写成 Happy）。
   */
  pick(tag: string): StickerView | undefined {
    const t = tag.trim();
    if (!t) return undefined;

    const exact = this.byTag.get(t) ?? this.byTag.get(t.toLowerCase());
    if (exact?.length) {
      const usable = exact.filter((s) => !s.missing);
      if (usable.length) return pickRandom(usable);
    }

    // 模糊：先比小写全等，再看包含关系
    const lower = t.toLowerCase();
    for (const [k, v] of this.byTag) {
      if (k.toLowerCase() === lower) {
        const usable = v.filter((s) => !s.missing);
        if (usable.length) return pickRandom(usable);
      }
    }
    for (const [k, v] of this.byTag) {
      const kl = k.toLowerCase();
      if (kl.includes(lower) || lower.includes(kl)) {
        const usable = v.filter((s) => !s.missing);
        if (usable.length) return pickRandom(usable);
      }
    }
    return undefined;
  }

  /** 随机取一张 */
  random(): StickerView | undefined {
    const usable = this.usable();
    return usable.length ? pickRandom(usable) : undefined;
  }

  /**
   * 按情绪挑一张：优先"AI 标注过该情绪且有描述"的，
   * 其次退化成任意被理解过的，最后退化成随机。
   *
   * 分级回退是为了：宁可发一张没那么贴切的图，也不要因为没标注就不发。
   * 但 `requireDesc` 打开时，连"被理解过"都达不到的就不发 —— 避免发出模型看不懂的怪图。
   */
  pickByEmotion(emotion: string, opts: { requireDesc?: boolean } = {}): StickerView | undefined {
    const pool = this.understood();
    if (pool.length === 0) {
      return opts.requireDesc ? undefined : this.random();
    }

    const exact = pool.filter((s) => s.emotions.some((e) => e.toLowerCase() === emotion.toLowerCase()));
    if (exact.length) {
      // 同一情绪里，优先还没发过的（简单轮换，减少重复）
      return pickRandom(exact);
    }
    return pickRandom(pool);
  }

  /**
   * 给提示词用的摘要。
   *
   * 两种形态：
   *   - 没有描述时：`happy(3) sad(2)`（老行为）
   *   - 有描述时：`happy: 鲸鱼竖大拇指得意笑`（让模型能按语义挑，而不只是按词挑）
   *
   * 有描述时按标签聚合，取该标签下第一条有描述的作代表。
   */
  describeForPrompt(maxTags = 40, descChars = 18): string {
    const usable = this.usable();
    if (usable.length === 0) return '';

    // 标签 → 代表描述
    const tagDesc = new Map<string, string>();
    for (const s of usable) {
      if (!s.desc.trim()) continue;
      for (const t of s.tags) {
        if (!tagDesc.has(t)) tagDesc.set(t, s.desc.trim());
      }
    }

    const tags = this.tags().filter((t) => this.countOf(t) > 0);
    if (tags.length === 0) return '';

    const shown = tags.slice(0, maxTags).map((t) => {
      const d = descChars > 0 ? tagDesc.get(t) : '';
      if (!d) return `${t}(${this.countOf(t)})`;
      const trimmed = d.length > descChars ? `${d.slice(0, descChars)}…` : d;
      return `${t}(${this.countOf(t)}): ${trimmed}`;
    });
    const more = tags.length > maxTags ? ` …等共 ${tags.length} 个标签` : '';
    return shown.join('\n') + more;
  }

  // ==================== manifest 写入 ====================

  /** 用一批条目更新/新增 manifest 记录（按 file 合并） */
  upsert(entries: StickerEntry[]): void {
    const current = this.readManifestRaw();
    const map = new Map(current.entries.map((e) => [normalizeRel(e.file), e]));
    for (const e of entries) {
      const key = normalizeRel(e.file);
      const old = map.get(key);
      map.set(key, old ? { ...old, ...e } : e);
    }
    this.writeManifestRaw({ version: 1, entries: [...map.values()] });
    this.reload();
  }

  /** 删除 manifest 记录 */
  forget(files: string[]): void {
    const keys = new Set(files.map(normalizeRel));
    const current = this.readManifestRaw();
    this.writeManifestRaw({
      version: 1,
      entries: current.entries.filter((e) => !keys.has(normalizeRel(e.file))),
    });
    // 必须重载：否则内存里还留着旧条目，调用方随后读到的仍是删除前的值。
    // 重载后若文件还在，会按文件名重建一条（等价于"恢复默认标签"），这是预期行为。
    this.reload();
  }

  /**
   * 把内存里的条目全部回写。
   * 注意：会丢掉 manifest 里"文件已不存在"但仍想保留的孤儿记录 —— 所以先合并再写。
   */
  syncManifest(): void {
    const current = this.readManifestRaw();
    const map = new Map(current.entries.map((e) => [normalizeRel(e.file), e]));
    for (const v of this.all) {
      const key = normalizeRel(v.file);
      // 缺失的条目：保留原记录（可能只是文件临时不在）
      if (v.missing) continue;
      map.set(key, { ...(map.get(key) ?? {}), ...toMeta(v) });
    }
    this.writeManifestRaw({ version: 1, entries: [...map.values()] });
  }

  private readManifestRaw(): StickerManifest {
    try {
      if (fs.existsSync(this.manifestPath)) {
        const raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
        const parsed = StickerManifestSchema.safeParse(raw);
        if (parsed.success) return parsed.data;
      }
    } catch {
      /* 损坏就当空的 */
    }
    return { version: 1, entries: [] };
  }

  private writeManifestRaw(m: StickerManifest): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.manifestPath, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  }

  /** manifest 绝对路径（面板展示用） */
  get manifestFile(): string {
    return this.manifestPath;
  }

  /** 目录绝对路径 */
  get root(): string {
    return this.dir;
  }
}

/** 取条目的持久化部分（去掉运行时字段） */
function toMeta(v: StickerView): StickerEntry {
  const e: StickerEntry = {
    file: v.file,
    tags: v.tags,
    desc: v.desc,
    useWhen: v.useWhen,
    emotions: v.emotions,
    source: v.source,
  };
  if (v.resId) e.resId = v.resId;
  if (v.md5) e.md5 = v.md5;
  if (v.emojiId) e.emojiId = v.emojiId;
  if (v.url) e.url = v.url;
  if (v.analyzedAt !== undefined) e.analyzedAt = v.analyzedAt;
  if (v.analyzedBy) e.analyzedBy = v.analyzedBy;
  return e;
}

/** 统一成 posix 风格相对路径，避免 Windows 反斜杠导致 manifest 键不一致 */
function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 递归列出所有图片（相对 dir 的路径，posix 风格） */
function walkImages(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(path.join(dir, prefix));
  } catch {
    return out;
  }
  for (const name of names) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = path.join(dir, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkImages(dir, rel));
    } else if (IMAGE_EXT.has(path.extname(name).toLowerCase())) {
      out.push(rel);
    }
  }
  return out;
}

/** 从文件名取标签：去掉扩展名和结尾的 _数字 / -数字 序号 */
export function tagFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  // 去掉结尾的序号（_1 / -2 / (3)）
  const cleaned = base.replace(/[_\-\s]*\(?\d+\)?$/, '').trim();
  return (cleaned || base).trim();
}

/**
 * 从模型回复里摘出表情标记。
 * 标记本身被移除，并把结果首尾空白清掉（避免留下 "正文 [表情:x]" 的尾随空格）。
 * @returns 清洗后的文本 + 用到的标签（按出现顺序、去重）
 */
export function extractStickerTags(text: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const cleaned = text.replace(STICKER_MARKER_RE, (_m, tag: string) => {
    const t = String(tag).trim();
    if (t && !tags.includes(t)) tags.push(t);
    return '';
  });
  return { text: tags.length > 0 ? cleaned.trim() : text, tags };
}

/** 图片扩展名是否受支持 */
export function isImageFile(name: string): boolean {
  return IMAGE_EXT.has(path.extname(name).toLowerCase());
}

function pickRandom<T>(arr: T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)];
}
