/**
 * A signal for an outbound call that aborts after `ms`, or as soon as one
 * of `also` does (the client going away). clear() stops the clock, so an
 * answer that began in time may stream on for as long as it takes; that is
 * why this is a timer and not AbortSignal.timeout, which cannot be stopped.
 */
export function deadline(ms: number, ...also: AbortSignal[]) {
  const clock = new AbortController();
  const timer = setTimeout(
    () => clock.abort(new DOMException(`no answer in ${ms} ms`, "TimeoutError")),
    ms,
  );
  return {
    signal: AbortSignal.any([clock.signal, ...also]),
    timedOut: () => clock.signal.aborted,
    clear: () => clearTimeout(timer),
  };
}
