import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { changedRows, type Db } from "./client.js";
import { auditEvents, preferences, preferenceVersions } from "./schema.js";

// The preferences' save as compare-and-set (audit C6): the row changes only
// while its version is still the one the save started from, and the version
// row and the audit event are written only when it did. One D1 batch, which
// D1 runs as one transaction. Only scoped() calls this.

type Values = Omit<
  typeof preferences.$inferInsert,
  "accountId" | "version" | "updatedAt" | "createdAt"
>;

export type PreferencesSave = {
  values: Values;
  /** The version the save started from; null when the account has none yet. */
  expected: string | null;
  /** The new version's id. */
  version: string;
  changed: string[];
  /** The newest versions kept. */
  keep: number;
  auditId: string;
};

/** Returns whether the save landed; false when another save changed the version first. */
export async function savePreferences(
  db: Db,
  accountId: string,
  save: PreferencesSave,
): Promise<boolean> {
  const p = preferences;
  const v = preferenceVersions;
  const now = Date.now();
  const set = { ...save.values, version: save.version, updatedAt: new Date(now) };
  // Written by this save: the version only it could have set.
  const landed = sql`EXISTS (SELECT 1 FROM ${p} WHERE ${p.accountId} = ${accountId}
    AND ${p.version} = ${save.version})`;
  const own = eq(v.accountId, accountId);
  const newest = db.select({ id: v.id }).from(v).where(own).orderBy(desc(v.createdAt));
  const [upsert] = await db.batch([
    db
      .insert(p)
      .values({ ...set, accountId })
      .onConflictDoUpdate({
        target: p.accountId,
        set,
        setWhere: sql`${p.version} IS NOT DISTINCT FROM ${save.expected}`,
      }),
    // In the table's column order: insert … select names every column.
    db.insert(v).select(sql`
      SELECT ${save.version}, ${accountId}, ${JSON.stringify(save.values)},
        ${JSON.stringify(save.changed)}, ${now}
      WHERE ${landed}`),
    db.delete(v).where(and(own, notInArray(v.id, newest.limit(save.keep)))),
    db.insert(auditEvents).select(sql`
      SELECT ${save.auditId}, ${accountId}, 'settings.changed',
        ${JSON.stringify({ keys: save.changed, version: save.version })},
        ${now}
      WHERE ${landed}`),
  ]);
  return changedRows(upsert) > 0;
}
