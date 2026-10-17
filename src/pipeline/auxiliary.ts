/** 辅助请求的等待预算；晚到结果不会影响本轮，取消信号传给实际调用。 */
export interface AuxiliaryFailure {
  kind: 'timeout' | 'cancelled' | 'error';
  error?: unknown;
  timeoutMs: number;
  elapsedMs: number;
}
export async function auxiliary<T>(run: (signal: AbortSignal) => Promise<T>, fallback: () => T,
  timeoutMs: number, parent?: AbortSignal, onFailure?: (failure: AuxiliaryFailure) => void): Promise<T> {
  const startedAt = Date.now();
  let timedOut = false, reported = false;
  const report = (kind: AuxiliaryFailure['kind'], error?: unknown) => {
    if (reported) return;
    reported = true;
    try { onFailure?.({kind, error, timeoutMs, elapsedMs:Date.now()-startedAt}); }
    catch { /* 诊断回调失败不影响原有降级与取消行为 */ }
  };
  const ctrl = new AbortController();
  const signal = parent ? AbortSignal.any([parent, ctrl.signal]) : ctrl.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(signal); }),
      new Promise<T>(resolve => {
        onAbort = () => { report(timedOut ? 'timeout' : 'cancelled', signal.reason); resolve(fallback()); };
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
        if (signal.aborted) onAbort();
      })]);
  } catch (error) { report(timedOut ? 'timeout' : signal.aborted ? 'cancelled' : 'error', error); return fallback(); }
  finally { if (timer) clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); ctrl.abort(); }
}
export function modulatedEmotion<T extends { label: string; intensity: number; valence: number; arousal: number; confidence: number }>(current: T,
  state: { intensity: number; valence: number; arousal: number }): T {
  const weight = current.confidence >= 0.8 ? 0.6 : 0.3;
  return { ...current, intensity: current.intensity * weight + state.intensity * (1 - weight),
    valence: current.valence * weight + state.valence * (1 - weight), arousal: current.arousal * weight + state.arousal * (1 - weight) };
}
