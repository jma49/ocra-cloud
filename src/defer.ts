import type { Context } from "hono";
import { errorName, logError } from "./log.js";

/**
 * Work that may finish after the answer, handed to the request's waitUntil:
 * the Worker's, or the Node host's, which waits for it before it closes.
 * A failure is logged, never thrown.
 */
export function defer(c: Context, work: Promise<unknown>): void {
  const logged = work.catch((err) => logError("deferred_failed", { error: errorName(err) }));
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    // Hono throws when the runtime gave no execution context.
  }
  ctx?.waitUntil(logged);
}
