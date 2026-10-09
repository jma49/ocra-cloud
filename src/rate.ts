import type { Context, MiddlewareHandler } from "hono";
import { apiError } from "./http.js";
import { secondsToNextUtcDay } from "./time.js";
import type { AppEnv } from "./types.js";

/** Tells a client refused by a daily cap when to try again: at midnight UTC. */
export function retryTomorrow(c: Context, now = new Date()): void {
  c.header("retry-after", String(secondsToNextUtcDay(now)));
}

/**
 * Refuses a signed-in account's request past ACCOUNT_CALLS' allowance per
 * minute, counted apart for each route, before the route's own queries: a
 * burst, or a client looping on a daily cap's refusal, reaches D1 no
 * further than the session lookup (audit C1). Goes after requireSession.
 * The binding counts in each Cloudflare location and is approximate, so it
 * shapes bursts; the daily caps, counted in D1, bound the totals.
 */
export function perMinute(route: "upload" | "gateway"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = `${route}:${c.var.session.account.id}`;
    const { success } = await c.env.ACCOUNT_CALLS.limit({ key });
    if (!success) {
      c.header("retry-after", "60");
      return apiError(c, "slow_down", {}, 429);
    }
    await next();
  };
}
