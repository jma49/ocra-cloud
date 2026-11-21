import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/** What a write's `run()` answers: D1 counts in `meta`, libSQL in `rowsAffected`. */
type RunResult = { meta: { changes: number } } | { rowsAffected: number };

/**
 * The database every query takes: D1 on Cloudflare, libSQL (SQLite) when
 * self-hosted. Both are Drizzle's async SQLite with the same batch, so the
 * queries are written once.
 */
export type Db = BaseSQLiteDatabase<"async", RunResult> & {
  batch: DrizzleD1Database["batch"];
};

export const changedRows = (result: RunResult): number =>
  "meta" in result ? result.meta.changes : result.rowsAffected;
