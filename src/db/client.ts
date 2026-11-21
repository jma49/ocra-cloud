import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/**
 * What a write answers: D1 counts in `meta`, libSQL in `rowsAffected`,
 * node-postgres in `rowCount` and PGlite in `affectedRows`.
 */
type RunResult =
  | { meta: { changes: number } }
  | { rowsAffected: number }
  | { rowCount: number | null }
  | { affectedRows?: number };

/**
 * The database every query takes: D1 on Cloudflare, libSQL (SQLite) or
 * Postgres when self-hosted. The type is Drizzle's async SQLite with D1's
 * batch; ../node/postgres.ts gives Postgres the same, so the queries are
 * written once.
 */
export type Db = BaseSQLiteDatabase<"async", RunResult> & {
  batch: DrizzleD1Database["batch"];
};

export function changedRows(result: RunResult): number {
  if ("meta" in result) return result.meta.changes;
  if ("rowsAffected" in result) return result.rowsAffected;
  if ("rowCount" in result) return result.rowCount ?? 0;
  return result.affectedRows ?? 0;
}

/** A query's first row, as SQLite's `.get()` answers it, on any dialect: `.limit(1).then(first)`. */
export const first = <T>(rows: readonly T[]): T | undefined => rows[0];
