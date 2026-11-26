import { desc, gt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { reviewRunners } from "./schema.js";

// The deployment's remote runners, as they last asked for work.

const t = reviewRunners;

/** A runner asks every few seconds; its row is written again only once this old. */
export const SEEN_EVERY_MS = 60_000;
/** A runner silent this long is no longer shown: a renamed or retired machine, one row each. */
const FORGOTTEN_AFTER_MS = 7 * 24 * 60 * 60_000;

/** Records that the runner asked for work now. */
export async function runnerSeen(db: Db, name: string, version: string, now: Date): Promise<void> {
  await db
    .insert(t)
    .values({ name, version, lastSeenAt: now })
    .onConflictDoUpdate({
      target: t.name,
      set: { version, lastSeenAt: now },
      setWhere: sql`${t.lastSeenAt} <= ${now.getTime() - SEEN_EVERY_MS} OR ${t.version} <> ${version}`,
    });
}

/** The runners heard from lately, newest first. */
export function recentRunners(db: Db, now: Date) {
  return db
    .select()
    .from(t)
    .where(gt(t.lastSeenAt, new Date(now.getTime() - FORGOTTEN_AFTER_MS)))
    .orderBy(desc(t.lastSeenAt))
    .limit(20);
}

/** When the runner heard from last asked for work, among those not yet forgotten; undefined with none. */
export async function newestRunnerSeen(db: Db, now: Date): Promise<Date | undefined> {
  const [newest] = await db
    .select({ at: t.lastSeenAt })
    .from(t)
    .where(gt(t.lastSeenAt, new Date(now.getTime() - FORGOTTEN_AFTER_MS)))
    .orderBy(desc(t.lastSeenAt))
    .limit(1);
  return newest?.at;
}
