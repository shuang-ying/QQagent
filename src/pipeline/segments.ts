/** 按 Unicode 码点分片，避免截断 emoji；优先保留自然断点。 */
export function splitMessage(text: string, maxLen = 500): string[] {
  const chars = Array.from(text); const parts: string[] = [];
  while (chars.length > maxLen) {
    const window = chars.slice(0, maxLen);
    let cut = maxLen;
    for (let i = window.length - 1; i >= maxLen / 2; i--) {
      if (/[\n。！？!?，,；;\s]/u.test(window[i]!)) { cut = i + 1; break; }
    }
    const piece = chars.splice(0, cut).join('').trim(); if (piece) parts.push(piece);
  }
  const tail = chars.join('').trim(); if (tail) parts.push(tail);
  return parts;
}
