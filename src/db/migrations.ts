import sqliteJournal from "../../migrations/meta/_journal.json" with { type: "json" };
import pgJournal from "../../migrations-pg/meta/_journal.json" with { type: "json" };
import type { Db } from "./client.js";
import { appliedMigrations } from "./dialect.js";

// The migrations this build was made with, from drizzle-kit's journals,
// against those the database says it applied: a replica started on a
// database another run has not migrated yet, or one whose MIGRATE=only
// run failed halfway.

type Journal = { entries: { tag: string; when: number }[] };

export type MigrationCheck = {
  expected: number;
  applied: number;
  /** The tags of the expected migrations not applied, oldest first. */
  missing: string[];
  /** Applied migrations this build does not know: a newer build migrated the database. */
  unknown: number;
};

/** The newest migration this build expects, on SQLite and D1. */
export const SCHEMA_TAG = (sqliteJournal as Journal).entries.at(-1)?.tag ?? "none";

/** How the database's applied migrations compare with this build's; undefined when it records none. */
export async function checkMigrations(db: Db): Promise<MigrationCheck | undefined> {
  const ledger = await appliedMigrations(db);
  if (!ledger) return undefined;
  const { entries } = (ledger.dialect === "postgres" ? pgJournal : sqliteJournal) as Journal;
  const keyOf = (e: Journal["entries"][number]) => (ledger.by === "tag" ? e.tag : String(e.when));
  const applied = new Set(ledger.applied);
  const known = new Set(entries.map(keyOf));
  return {
    expected: entries.length,
    applied: applied.size,
    missing: entries.filter((e) => !applied.has(keyOf(e))).map((e) => e.tag),
    unknown: [...applied].filter((key) => !known.has(key)).length,
  };
}
