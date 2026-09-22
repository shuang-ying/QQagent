/**
 * 配置写回器
 *
 * 面板需要修改 config/app.yaml 里的单个值。直接 parse + 重新序列化会把
 * 用户文件里的注释、空行、对齐全部抹掉，所以这里做「手术式」行编辑：
 * 只替换目标行的值部分，保留行尾注释、缩进和其余内容原样不动。
 *
 * 支持：
 *  - 修改已有键的标量值（保留行尾注释）
 *  - 目标键不存在时按缩进插入
 *  - 中间层级不存在时自动补出映射层级（如 llm.roles.embedding.provider）
 */
import fs from 'node:fs';

/** 判断一行是不是「空行或纯注释」（不参与层级判断） */
function isSkippable(line: string): boolean {
  return line.trim() === '' || /^\s*#/.test(line);
}

/** 取一行的缩进宽度；空行/注释返回 null */
function indentOf(line: string): number | null {
  if (isSkippable(line)) return null;
  return /^(\s*)/.exec(line)![1]!.length;
}

/** 取一行的键名；不是映射行返回 null */
function keyOf(line: string): string | null {
  if (isSkippable(line)) return null;
  const m = /^\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:/.exec(line);
  return m ? m[1]! : null;
}

/** 把 JS 值格式化成 YAML 标量/流式数组 */
function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (v === null || v === undefined) return '""';
  if (Array.isArray(v)) return JSON.stringify(v);
  const s = String(v);
  if (s === '') return '""';
  // 简单 token 直接裸写，保持配置文件整洁
  if (/^[A-Za-z0-9_./@+-]+$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return s;
  return JSON.stringify(s);
}

/** 替换某行的值部分，保留缩进、键名与行尾注释 */
function replaceLineValue(line: string, value: unknown): string {
  const m = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*)(\s*):(\s*)(.*)$/.exec(line);
  if (!m) return line;
  const [, indent, key, pre, post, rest] = m;
  // 保留行尾注释（含它前面的空白）
  const cm = /^(.*?)(\s+#.*)$/.exec(rest ?? '');
  const comment = cm ? cm[2] : '';
  return `${indent}${key}${pre}:${post}${formatValue(value)}${comment}`;
}

/** 在 [from,to) 内查找指定缩进层级的键所在行 */
function findKeyLine(lines: string[], key: string, indent: number, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    if (indentOf(line) !== indent) continue;
    if (keyOf(line) === key) return i;
  }
  return -1;
}

/** 某键所在块的内容结束行号（不含） */
function blockEnd(lines: string[], keyLine: number, indent: number): number {
  for (let i = keyLine + 1; i < lines.length; i++) {
    const ind = indentOf(lines[i]!);
    if (ind === null) continue; // 空行/注释算在块内
    if (ind <= indent) return i;
  }
  return lines.length;
}

/** 探测某个块内子键的缩进；没有子键则用 fallback */
function childIndent(lines: string[], from: number, to: number, fallback: number): number {
  for (let i = from; i < to; i++) {
    const ind = indentOf(lines[i]!);
    if (ind !== null) return ind;
  }
  return fallback;
}

/** 取一行 `key: <value>` 里的 value（已剥离行尾注释）；不是映射行返回 undefined */
function inlineValueOf(line: string): string | undefined {
  const m = /^\s*[A-Za-z0-9_][A-Za-z0-9_.-]*\s*:\s*(.*)$/.exec(line);
  if (!m) return undefined;
  const raw = m[1] ?? '';
  const cm = /^(.*?)(\s+#.*)$/.exec(raw);
  return (cm?.[1] ?? raw).trim();
}

/** 把 `key: {}` / `key: []` 之类的内联空容器改写成 `key:`，保留行尾注释 */
function toBlockMapping(line: string): string {
  const m = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*)(\s*):(\s*)(.*)$/.exec(line);
  if (!m) return line;
  const [, indent, key, pre, , rest] = m;
  const cm = /^(.*?)(\s+#.*)$/.exec(rest ?? '');
  const comment = cm ? cm[2] : '';
  return `${indent}${key}${pre}:${comment}`;
}

/**
 * 计算插入位置：默认插到块尾，但要回退跳过紧邻的空行与注释，
 * 否则新键会落到「下一个区块的说明注释」后面，看起来像属于下一节。
 */
function insertPos(lines: string[], to: number, floor: number): number {
  let i = to;
  while (i > floor && isSkippable(lines[i - 1]!)) i--;
  return i;
}

/**
 * 递归设置路径；直接修改传入的 lines 数组。
 * @returns 是否成功（false 表示遇到了无法安全写入的结构）
 */
function setInLines(
  lines: string[],
  path: string[],
  value: unknown,
  indent: number,
  from: number,
  to: number,
): boolean {
  const key = path[0]!;
  const rest = path.slice(1);
  const idx = findKeyLine(lines, key, indent, from, to);

  // ---- 末级：写入标量 ----
  if (rest.length === 0) {
    if (idx >= 0) {
      lines[idx] = replaceLineValue(lines[idx]!, value);
      return true;
    }
    lines.splice(insertPos(lines, to, from), 0, `${' '.repeat(indent)}${key}: ${formatValue(value)}`);
    return true;
  }

  // ---- 中间层级 ----
  if (idx < 0) {
    // 中间映射不存在：补一行 `key:`，再在它下面继续写
    const at = insertPos(lines, to, from);
    lines.splice(at, 0, `${' '.repeat(indent)}${key}:`);
    return setInLines(lines, rest, value, indent + 2, at + 1, at + 1);
  }

  // 已有该键：如果它是内联值（如 `roles: {}`），必须先转成块映射，
  // 否则在它下面追加子键会生成非法 YAML（All mapping items must start...）。
  const inline = inlineValueOf(lines[idx]!);
  if (inline !== undefined && inline !== '') {
    if (inline === '{}' || inline === '[]') {
      lines[idx] = toBlockMapping(lines[idx]!);
    } else {
      // 标量或非空容器：不能安全地当作映射继续下钻，放弃这一条
      return false;
    }
  }

  const end = blockEnd(lines, idx, indent);
  const sub = childIndent(lines, idx + 1, end, indent + 2);
  return setInLines(lines, rest, value, sub, idx + 1, end);
}

/**
 * 批量修改同一个配置文件里的多个值（只读写一次，减少出错面）。
 *
 * @param file 目标 YAML 文件绝对路径
 * @param entries [[路径, 值], ...]，路径如 ['emotion','enabled']
 * @throws 当某个路径无法安全写入时（例如中间键是标量），
 *         整批不落盘并抛出，避免写出半截损坏的配置。
 */
export function setConfigValues(file: string, entries: Array<[string[], unknown]>): void {
  const original = fs.readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);

  const failed: string[] = [];
  for (const [path, value] of entries) {
    if (path.length === 0) continue;
    if (!setInLines(lines, path, value, 0, 0, lines.length)) {
      failed.push(path.join('.'));
    }
  }

  if (failed.length > 0) {
    throw new Error(
      `无法写入配置项：${failed.join(', ')}（目标位置不是映射结构，请手工调整 app.yaml 后重试）`,
    );
  }

  fs.writeFileSync(file, lines.join(eol), 'utf8');
}

/** 单值便捷写法 */
export function setConfigValue(file: string, path: string[], value: unknown): void {
  setConfigValues(file, [[path, value]]);
}

/**
 * 读取某个 YAML 文件的原始文本（用于追加/删除整块，如 providers、personas）。
 */
export function readConfigText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}
