/**
 * A signal for an outbound call that aborts after `ms`, or as soon as one
 * of `also` does (the client going away). clear() disarms it: the clock
 * stops and `also` no longer reaches it, so an answer that began in time
 * may stream on for as long as it takes, and ends only as its reader ends
 * it. That is why this is a timer and listeners, not AbortSignal.timeout
 * and AbortSignal.any, which cannot be disarmed.
 */
export function deadline(ms: number, ...also: AbortSignal[]) {
  const clock = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    clock.abort(new DOMException(`no answer in ${ms} ms`, "TimeoutError"));
  }, ms);
  const listeners = also.map((from) => [from, () => clock.abort(from.reason)] as const);
  for (const [from, listener] of listeners) {
    if (from.aborted) listener();
    else from.addEventListener("abort", listener, { once: true });
  }
  return {
    signal: clock.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      for (const [from, listener] of listeners) from.removeEventListener("abort", listener);
    },
  };
}
