/**
 * The Workers rate limiting binding's behaviour in one process: at most
 * `limit` calls per key in each `periodSeconds` window. A self-hosted server
 * is one process, so a map is the whole store; windows that ended are
 * dropped as they are passed.
 */
export function memoryRateLimit(limit: number, periodSeconds: number): RateLimit {
  const windows = new Map<string, { start: number; n: number }>();
  const period = periodSeconds * 1000;
  return {
    async limit({ key }) {
      const now = Date.now();
      const w = windows.get(key);
      if (!w || now - w.start >= period) {
        if (windows.size > 10_000) {
          for (const [k, v] of windows) if (now - v.start >= period) windows.delete(k);
        }
        windows.set(key, { start: now, n: 1 });
        return { success: true };
      }
      w.n += 1;
      return { success: w.n <= limit };
    },
  };
}
