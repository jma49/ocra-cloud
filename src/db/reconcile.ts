import { and, asc, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { type Db, first } from "./client.js";
import { reviewRepos } from "./schema.js";

// The daily reconciliation's turn (src/reconcile.ts), across accounts: each
// enrolled repository is claimed once per UTC day, by a compare-and-set on
// when it was last claimed, so two runs at once, or a run every hour, read
// it once a day. A run that ran out of calls before it finished a
// repository gives the claim back, so the next run reads it again. One whose
// platform did not answer gives it back too, a few times a day: its retries
// are counted in the milliseconds before the day's midnight it is set back
// to, so a retry is due after every repository not yet read that day and
// the count needs no column of its own; the next day starts it over.

export type ReconcileTurn = {
  id: string;
  accountId: string;
  platform: (typeof reviewRepos.$inferSelect)["platform"];
  host: string;
  fullName: string;
  createdAt: Date;
  /** When it was claimed before this claim; null the first time. */
  previous: Date | null;
  claimedAt: Date;
};

/** Reads of a repository a UTC day whose platform did not answer, the first included. */
const RECONCILE_TRIES = 3;

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
    if (claimed) return { ...claimed, previous: next.reconciledAt, claimedAt: now };
  }
  return undefined;
}

/**
 * Gives back a claim whose run did not finish the repository: it is due
 * again, with the time it waited before, unless another run claimed it since.
 */
export async function releaseReconcile(db: Db, turn: ReconcileTurn): Promise<void> {
  const t = reviewRepos;
  await db
    .update(t)
    .set({ reconciledAt: turn.previous })
    .where(and(eq(t.id, turn.id), eq(t.reconciledAt, turn.claimedAt)));
}

/**
 * Gives back a claim whose platform did not answer, so a later run of the
 * same day tries again, unless it was tried RECONCILE_TRIES times that day
 * or another run claimed it since; whether it was given back.
 */
export async function retryReconcile(db: Db, turn: ReconcileTurn): Promise<boolean> {
  const day = dayOf(turn.claimedAt).getTime();
  const before = turn.previous?.getTime() ?? 0;
  const tried = before < day && before >= day - RECONCILE_TRIES ? day - before : 0;
  if (tried + 1 >= RECONCILE_TRIES) return false;
  const t = reviewRepos;
  const back = await db
    .update(t)
    .set({ reconciledAt: new Date(day - (tried + 1)) })
    .where(and(eq(t.id, turn.id), eq(t.reconciledAt, turn.claimedAt)))
    .returning({ id: t.id })
    .then(first);
  return back !== undefined;
}
