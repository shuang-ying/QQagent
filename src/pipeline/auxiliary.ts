/** 辅助请求的等待预算；晚到结果不会影响本轮，取消信号传给实际调用。 */
export async function auxiliary<T>(run: (signal: AbortSignal) => Promise<T>, fallback: () => T,
  timeoutMs: number, parent?: AbortSignal): Promise<T> {
  const ctrl = new AbortController();
  const signal = parent ? AbortSignal.any([parent, ctrl.signal]) : ctrl.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(signal); }),
      new Promise<T>(resolve => {
        onAbort = () => resolve(fallback());
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { ctrl.abort(); }, timeoutMs);
        if (signal.aborted) onAbort();
      })]);
  } catch { return fallback(); }
  finally { if (timer) clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); ctrl.abort(); }
}
export function modulatedEmotion<T extends { label: string; intensity: number; valence: number; arousal: number; confidence: number }>(current: T,
  state: { intensity: number; valence: number; arousal: number }): T {
  const weight = current.confidence >= 0.8 ? 0.6 : 0.3;
  return { ...current, intensity: current.intensity * weight + state.intensity * (1 - weight),
    valence: current.valence * weight + state.valence * (1 - weight), arousal: current.arousal * weight + state.arousal * (1 - weight) };
}
