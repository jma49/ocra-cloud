import { AsyncLocalStorage } from "node:async_hooks";

// Whether a code platform said, during this request, that the user's
// allowance of calls is used up, and until when. A call that fails reads
// as null to its caller, so the request's answer is replaced afterwards
// (src/platform-limits.ts) rather than each caller telling the two apart.

type Scope = { until: number | null };
const scopes = new AsyncLocalStorage<Scope>();

/** Runs `fn` with a fresh record of the platforms' limits. */
export function withPlatformLimits<T>(fn: (scope: Readonly<Scope>) => Promise<T>): Promise<T> {
  const scope: Scope = { until: null };
  return scopes.run(scope, () => fn(scope));
}

/** When the user's allowance is back, if a platform said this request that it is used up. */
export const platformLimitedUntil = (): number | null => scopes.getStore()?.until ?? null;

/**
 * Notes a platform's answer that says the allowance is used up: GitHub's
 * x-ratelimit-remaining of 0 (its 403, or a GraphQL answer), a 429, or a
 * 403 with retry-after (GitHub's secondary limit).
 */
export function notePlatformLimit(res: Response, now = Date.now()): void {
  const scope = scopes.getStore();
  if (!scope) return;
  const h = res.headers;
  const exhausted =
    h.get("x-ratelimit-remaining") === "0" ||
    res.status === 429 ||
    (res.status === 403 && h.has("retry-after"));
  if (!exhausted) return;
  const retry = Number(h.get("retry-after"));
  const reset = Number(h.get("x-ratelimit-reset") ?? h.get("ratelimit-reset"));
  const until =
    Number.isFinite(retry) && retry > 0
      ? now + retry * 1000
      : Number.isFinite(reset) && reset > 0
        ? reset * 1000
        : now + 60_000;
  scope.until = Math.max(scope.until ?? 0, until);
}
