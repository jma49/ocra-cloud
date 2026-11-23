import { and, asc, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { type Db, first } from "./client.js";
import { reviewRepos } from "./schema.js";

// The daily reconciliation's turn (src/reconcile.ts), across accounts: each
// enrolled repository is claimed once per UTC day, by a compare-and-set on
// when it was last claimed, so two runs at once, or a run every hour, read
// it once a day.

export type ReconcileTurn = {
  id: string;
  accountId: string;
  platform: (typeof reviewRepos.$inferSelect)["platform"];
  host: string;
  fullName: string;
  createdAt: Date;
};

/** Midnight UTC of now's day. */
const dayOf = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * Claims the repository not read today that waited longest, of an account
 * not in skip; undefined when there is none. Losing the claim to another
 * run tries the next one.
 */
export async function claimReconcile(
  db: Db,
  now: Date,
  skip: readonly string[] = [],
): Promise<ReconcileTurn | undefined> {
  const t = reviewRepos;
  const day = dayOf(now);
  const due = or(isNull(t.reconciledAt), lt(t.reconciledAt, day));
  for (let tries = 0; tries < 3; tries++) {
    const next = await db
      .select({ id: t.id, reconciledAt: t.reconciledAt })
      .from(t)
      .where(and(due, skip.length > 0 ? notInArray(t.accountId, [...skip]) : undefined))
      // Never read before first; then by when it was last read.
      .orderBy(sql`coalesce(${t.reconciledAt}, 0)`, asc(t.id))
      .limit(1)
      .then(first);
    if (!next) return undefined;
    const was = next.reconciledAt ? eq(t.reconciledAt, next.reconciledAt) : isNull(t.reconciledAt);
    const claimed = await db
      .update(t)
      .set({ reconciledAt: now })
      .where(and(eq(t.id, next.id), was))
      .returning({
        id: t.id,
        accountId: t.accountId,
        platform: t.platform,
        host: t.host,
        fullName: t.fullName,
        createdAt: t.createdAt,
      })
      .then(first);
    if (claimed) return claimed;
  }
  return undefined;
}
