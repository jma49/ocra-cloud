import type { Db } from "../db/client.js";
import { countInWindow } from "../db/rate-windows.js";

// The Worker's rate limiting bindings on Node, with the same allowances
// (wrangler.jsonc). One process counts in memory; several that share a
// database count there (RATE_LIMITS=database), so that each limit holds for
// the deployment rather than for each process.

type Limits = { DEVICE_CODES: RateLimit; DEVICE_LOOKUPS: RateLimit; ACCOUNT_CALLS: RateLimit };

const ALLOWANCES = {
  DEVICE_CODES: { limit: 10, periodSeconds: 60 },
  DEVICE_LOOKUPS: { limit: 20, periodSeconds: 60 },
  ACCOUNT_CALLS: { limit: 120, periodSeconds: 60 },
} as const;

/** Where the rate limits count. */
export type RateLimitStore = "memory" | "database";

/** RATE_LIMITS: memory when unset; throws on anything else than memory or database. */
export function rateLimitStore(value: string | undefined): RateLimitStore {
  if (!value || value === "memory") return "memory";
  if (value === "database") return value;
  throw new Error(`RATE_LIMITS must be memory or database, not ${value}`);
}

/** Every binding, counted in this process's memory or in `db`. */
export function rateLimits(store: { db: Db } | "memory"): Limits {
  const make = (name: keyof Limits) => {
    const { limit, periodSeconds } = ALLOWANCES[name];
    return store === "memory"
      ? memoryRateLimit(limit, periodSeconds)
      : databaseRateLimit(store.db, name, limit, periodSeconds);
  };
  return {
    DEVICE_CODES: make("DEVICE_CODES"),
    DEVICE_LOOKUPS: make("DEVICE_LOOKUPS"),
    ACCOUNT_CALLS: make("ACCOUNT_CALLS"),
  };
}

/** At most `limit` calls per key in each `periodSeconds` window, counted in the database. */
export function databaseRateLimit(
  db: Db,
  name: string,
  limit: number,
  periodSeconds: number,
): RateLimit {
  return {
    async limit({ key }) {
      const n = await countInWindow(db, `${name}:${key}`, periodSeconds * 1000);
      return { success: n <= limit };
    },
  };
}

/**
 * The Workers rate limiting binding's behaviour in one process: at most
 * `limit` calls per key in each `periodSeconds` window, kept in a map;
 * windows that ended are dropped as they are passed.
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
