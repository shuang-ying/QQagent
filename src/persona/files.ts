/**
 * 人格文件读写
 *
 * 每个人格对应 config/personas/<id>.yaml。面板的新增/编辑/删除走这里，
 * 与启动时的 loader 使用同一套 zod 校验，保证写进去的必定能被读出来。
 *
 * 注意：保存时会重新生成整个 YAML 文件（systemPrompt 是多行文本，
 * 手术式行编辑无法可靠处理），因此该文件里手写的注释会在面板保存后丢失。
 * 文件头部会写一行提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PersonaSchema, type Persona } from '../core/types.js';

/** 人格 id 只允许安全字符，避免路径穿越 */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidPersonaId(id: string): boolean {
  return SAFE_ID.test(id);
}

export function personaDir(root: string): string {
  return path.join(root, 'config', 'personas');
}

export function personaFile(root: string, id: string): string {
  return path.join(personaDir(root), `${id}.yaml`);
}

/** 读取目录下全部人格（与 loader 同规则：忽略 .local.） */
export function loadPersonasFromDir(root: string): Persona[] {
  const dir = personaDir(root);
  if (!fs.existsSync(dir)) return [];

  const out: Persona[] = [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f) && !f.includes('.local.'))
    .sort();

  for (const f of files) {
    const full = path.join(dir, f);
    const doc = parseYaml(fs.readFileSync(full, 'utf8'));
    const parsed = PersonaSchema.safeParse(doc);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
        .join('; ');
      throw new Error(`${f}: ${issues}`);
    }
    out.push(parsed.data);
  }
  return out;
}

/** 写入（新增或覆盖）一个人格文件 */
export function writePersona(root: string, persona: Persona): string {
  if (!isValidPersonaId(persona.id)) {
    throw new Error('人格 id 只能用小写字母、数字、下划线和短横线，且不超过 32 个字符');
  }

  const dir = personaDir(root);
  fs.mkdirSync(dir, { recursive: true });

  // 先校验，避免把非法内容写进磁盘导致下次启动失败
  const parsed = PersonaSchema.safeParse(persona);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
      .join('; ');
    throw new Error(`人格内容不合法：${issues}`);
  }

  const body = stringifyYaml(parsed.data, {
    lineWidth: 0, // 不折行，长 systemPrompt 保持一行一值
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
  });

  const header = [
    '# 由管理面板生成/更新。',
    '# 可以手改，但下次在面板里保存该人格时，本文件会被重新生成（注释会丢）。',
    '',
  ].join('\n');

  const file = personaFile(root, persona.id);
  fs.writeFileSync(file, header + body, 'utf8');
  return file;
}

/** 删除一个人格文件；返回是否真的删掉了 */
export function deletePersonaFile(root: string, id: string): boolean {
  if (!isValidPersonaId(id)) return false;
  const file = personaFile(root, id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** 人格是否已存在（文件层面） */
export function personaFileExists(root: string, id: string): boolean {
  return isValidPersonaId(id) && fs.existsSync(personaFile(root, id));
}
