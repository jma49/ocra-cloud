import type { Context } from "hono";
import { errorName, logError } from "./log.js";

/**
 * Work that may finish after the answer: on Workers it is handed to the
 * request's waitUntil; a Node server has no execution context and keeps
 * running it on its own. A failure is logged either way, never thrown.
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
