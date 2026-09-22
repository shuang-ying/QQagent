/**
 * 管理面板前端
 *
 * 面板是一个独立的 HTML 文件（src/web/panel.html），运行时读入内存并缓存。
 * 之所以不内联成 TS 模板字符串：面板里的 JS 大量使用反引号，
 * 嵌套在模板字符串里会互相干扰，可读性和可维护性都很差。
 *
 * 定位方式：从模块所在目录逐级向上找 src/web/panel.html，
 * 这样 tsx 直跑源码和 node 跑 dist 产物都能找到（dist 里不会拷贝 html）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

function candidatePaths(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out: string[] = [path.join(here, 'panel.html')];

  // 逐级向上查找 src/web/panel.html
  let dir = here;
  for (let i = 0; i < 6; i++) {
    out.push(path.join(dir, 'src', 'web', 'panel.html'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 环境变量显式指定项目根时的兜底
  if (process.env.QQ_AGENT_ROOT) {
    out.push(path.join(process.env.QQ_AGENT_ROOT, 'src', 'web', 'panel.html'));
  }
  return [...new Set(out)];
}

export function getPanelHtml(): string {
  if (cached) return cached;

  for (const p of candidatePaths()) {
    try {
      if (fs.existsSync(p)) {
        cached = fs.readFileSync(p, 'utf8');
        return cached;
      }
    } catch {
      /* 尝试下一个路径 */
    }
  }

  // 极端情况下的兜底：返回可读的错误页而不是崩溃
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>面板加载失败</title></head>
<body style="font-family:sans-serif;background:#0f1115;color:#e4e7ec;padding:40px">
<h1>⚠ 无法加载面板文件</h1>
<p>请确认 <code>src/web/panel.html</code> 存在。</p>
<p>已尝试路径：</p><ul>${candidatePaths().map((p) => `<li><code>${p}</code></li>`).join('')}</ul>
</body></html>`;
}
