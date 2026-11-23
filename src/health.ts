import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "./db/client.js";
import { checkMigrations, type MigrationCheck } from "./db/migrations.js";
import { newestRunnerSeen } from "./db/review-runners.js";
import { apiError } from "./http.js";
import { errorName, logError } from "./log.js";
import type { AppEnv } from "./types.js";

// /api/health answers without reading anything: deploys and container
// health checks call it, and on the Free plan D1's rows are a daily quota
// shared by every account (audit C1). ?deep=1 reads the database: that it
// answers, that this build's migrations are applied, and on a host whose
// remote runners report in, that one did lately. Limited per address like
// a device lookup, so a loop cannot spend the quota.

/** A runner rewrites its row once a minute while it polls (./db/review-runners.ts). */
export const RUNNER_STALE_MS = 5 * 60_000;
const CHECK_TIMEOUT_MS = 5_000;
const MISSING_SHOWN = 10;

export type DeepHealth = {
  ok: boolean;
  reasons: string[];
  migrations: MigrationCheck | null;
  runnerSeenAt?: string | null;
};

export function healthRoute(options: { runners: boolean }) {
  const route = new Hono<AppEnv>();
  route.get("/", async (c) => {
    if (c.req.query("deep") !== "1") return c.json({ ok: true });
    const { success } = await c.env.DEVICE_LOOKUPS.limit({ key: `health:${c.var.clientAddress}` });
    if (!success) {
      c.header("retry-after", "60");
      return apiError(c, "slow_down", {}, 429);
    }
    const body = await deepHealth(c.var.db, options.runners, new Date());
    return c.json(body satisfies DeepHealth, body.ok ? 200 : 503);
  });
  return route;
}

export async function deepHealth(db: Db, runners: boolean, now: Date): Promise<DeepHealth> {
  const reached = await within(db.run(sql`SELECT 1`));
  if (!reached.ok) return { ok: false, reasons: [`database_${reached.failed}`], migrations: null };
  const reasons: string[] = [];
  const body: DeepHealth = { ok: false, reasons, migrations: null };
  const checked = await within(checkMigrations(db));
  if (!checked.ok) reasons.push(`migrations_${checked.failed}`);
  else if (!checked.value) reasons.push("migrations_unrecorded");
  else {
    body.migrations = { ...checked.value, missing: checked.value.missing.slice(0, MISSING_SHOWN) };
    if (checked.value.missing.length > 0) reasons.push("migrations_missing");
  }
  if (runners) {
    const seen = await within(newestRunnerSeen(db, now));
    if (!seen.ok) reasons.push(`runners_${seen.failed}`);
    else {
      body.runnerSeenAt = seen.value?.toISOString() ?? null;
      const age = seen.value ? now.getTime() - seen.value.getTime() : 0;
      if (age > RUNNER_STALE_MS) reasons.push("runner_stale");
    }
  }
  body.ok = reasons.length === 0;
  return body;
}

type Checked<T> = { ok: true; value: T } | { ok: false; failed: "error" | "timeout" };

/** How `work` settled, in time: a database that hangs fails the check, not the request. */
async function within<T>(work: Promise<T>): Promise<Checked<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Checked<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, failed: "timeout" }), CHECK_TIMEOUT_MS);
  });
  const settled = work.then(
    (value): Checked<T> => ({ ok: true, value }),
    (err: unknown): Checked<T> => {
      logError("health_check_failed", { error: errorName(err) });
      return { ok: false, failed: "error" };
    },
  );
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}
