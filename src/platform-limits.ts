import type { Context, MiddlewareHandler } from "hono";
import { apiError } from "./http.js";
import { withPlatformLimits } from "./platforms/rate-limit.js";
import { PLATFORM_RATE_LIMITED } from "./shared/index.js";

/** The refusal of a request a code platform refused because the user's allowance is used up. */
export const rateLimited = (c: Context, until: number) =>
  apiError(c, "upstream_unreachable", {
    reason: PLATFORM_RATE_LIMITED,
    retryAt: new Date(until).toISOString(),
  });

/**
 * Records the platforms' limits for each request, and answers a request
 * that failed after one said the allowance is used up with that, not with
 * the not_found or upstream_unreachable its handler made of a null.
 */
export const platformLimits: MiddlewareHandler = async (c, next) =>
  withPlatformLimits(async (scope) => {
    await next();
    if (scope.until !== null && c.res.status >= 400) c.res = rateLimited(c, scope.until);
  });
