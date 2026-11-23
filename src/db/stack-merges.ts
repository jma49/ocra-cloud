import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { StackMergeReason, StackMergeState } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { jsonHoldsNumber } from "./dialect.js";
import { stackMerges } from "./schema.js";

// The account's stack merges (reached through scoped()). One row per stack
// bottom, started again in place once the last one ended; each step is
// taken by the one caller whose compare-and-set moved the row from waiting
// to running, and a lease that lapsed (a runner that died) can be taken
// again. A cancel moves the row out of running, so the runner's next write,
// which names its claim, changes nothing.

export type StackMerge = typeof stackMerges.$inferSelect;

export type StackKey = { platform: StackMerge["platform"]; host: string; fullName: string };

type Starting = StackKey & Pick<StackMerge, "bottom" | "trunk" | "method" | "chain" | "startedBy">;

/** What a step may change while its runner holds the claim. */
export type StackProgress = Partial<
  Pick<StackMerge, "chain" | "step" | "current" | "head" | "updatedFrom" | "restacked">
>;

type Ended = Exclude<StackMergeState, "waiting" | "running">;

/** How long a step may hold its claim before another runner may take it. */
const STACK_LEASE_MS = 5 * 60_000;

const ACTIVE = ["waiting", "running"] as const;

/** The repository's path as rows hold it: platforms read paths without case. */
const stackPath = (fullName: string) => fullName.toLowerCase();

export function accountStackMerges(db: Db, accountId: string) {
  const t = stackMerges;
  const ofRepo = (key: StackKey) =>
    and(
      eq(t.accountId, accountId),
      eq(t.platform, key.platform),
      eq(t.host, key.host),
      eq(t.fullName, stackPath(key.fullName)),
    );
  const claimedBy = (id: string, claim: Date) =>
    and(eq(t.accountId, accountId), eq(t.id, id), eq(t.state, "running"), eq(t.claimedAt, claim));
  return {
    of: (key: StackKey, bottom: number): Promise<StackMerge | undefined> =>
      db
        .select()
        .from(t)
        .where(and(ofRepo(key), eq(t.bottom, bottom)))
        .limit(1)
        .then(first),

    /** The newest merge whose chain holds `number`, whichever layer it is and whatever merged below it. */
    holding: (key: StackKey, number: number): Promise<StackMerge | undefined> =>
      db
        .select()
        .from(t)
        .where(and(ofRepo(key), jsonHoldsNumber(db, t.chain, "number", number)))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(1)
        .then(first),

    byId: (id: string): Promise<StackMerge | undefined> =>
      db
        .select()
        .from(t)
        .where(and(eq(t.accountId, accountId), eq(t.id, id)))
        .limit(1)
        .then(first),

    /** The merges a webhook concerns: on one pull request, or on the commit it names. */
    active(key: StackKey, at: { number: number } | { head: string }, limit = 20) {
      const which = "number" in at ? eq(t.current, at.number) : eq(t.head, at.head);
      return db
        .select()
        .from(t)
        .where(and(ofRepo(key), which, inArray(t.state, ACTIVE)))
        .limit(limit);
    },

    /**
     * Starts a merge of the stack, replacing an earlier one of the same
     * bottom unless that one is still under way (and its claim has not
     * lapsed); the row as it now stands.
     */
    async start(merge: Starting, now: Date): Promise<StackMerge | undefined> {
      const [layer] = merge.chain;
      if (!layer) return undefined;
      const fields = {
        path: merge.fullName,
        trunk: merge.trunk,
        method: merge.method,
        chain: merge.chain,
        step: 0,
        current: layer.number,
        head: layer.head,
        updatedFrom: null,
        restacked: [],
        startedBy: merge.startedBy,
        state: "waiting" as const,
        reason: null,
        claimedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await db
        .insert(t)
        .values({
          id: crypto.randomUUID(),
          accountId,
          platform: merge.platform,
          host: merge.host,
          fullName: stackPath(merge.fullName),
          bottom: merge.bottom,
          ...fields,
        })
        .onConflictDoUpdate({
          target: [t.accountId, t.platform, t.host, t.fullName, t.bottom],
          set: fields,
          // The conflict is on a key that starts with the account: the row is its own.
          setWhere: sql`(${t.state} NOT IN ('waiting', 'running') OR (${t.state} = 'running' AND ${t.claimedAt} < ${now.getTime() - STACK_LEASE_MS}))`,
        });
      return this.of(merge, merge.bottom);
    },

    /** Takes the next step of a waiting merge; the claim, for one caller, or null. */
    async claim(id: string, now: Date): Promise<Date | null> {
      const lapsed = new Date(now.getTime() - STACK_LEASE_MS);
      const taken = await db
        .update(t)
        .set({ state: "running", claimedAt: now, updatedAt: now })
        .where(
          and(
            eq(t.accountId, accountId),
            eq(t.id, id),
            or(
              eq(t.state, "waiting"),
              and(eq(t.state, "running"), isNotNull(t.claimedAt), lt(t.claimedAt, lapsed)),
            ),
          ),
        );
      return changedRows(taken) > 0 ? now : null;
    },

    /** Records a step under the claim; false when the claim is gone (cancelled, taken over). */
    async save(id: string, claim: Date, progress: StackProgress, now: Date): Promise<boolean> {
      const saved = await db
        .update(t)
        .set({ ...progress, updatedAt: now })
        .where(claimedBy(id, claim));
      return changedRows(saved) > 0;
    },

    /** Gives the claim back, waiting on what `reason` says. */
    async release(id: string, claim: Date, reason: StackMergeReason, now: Date): Promise<boolean> {
      const back = await db
        .update(t)
        .set({ state: "waiting", reason, claimedAt: null, updatedAt: now })
        .where(claimedBy(id, claim));
      return changedRows(back) > 0;
    },

    /** Ends a merge the caller claimed; whether it was still its claim. */
    async finish(
      id: string,
      claim: Date,
      state: Ended,
      reason: StackMergeReason | null,
      now: Date,
    ): Promise<boolean> {
      const done = await db
        .update(t)
        .set({ state, reason, claimedAt: null, finishedAt: now, updatedAt: now })
        .where(claimedBy(id, claim));
      return changedRows(done) > 0;
    },

    /** Cancels a merge under way; a step already sent to the platform is not undone. */
    async cancel(id: string, now: Date): Promise<boolean> {
      const cancelled = await db
        .update(t)
        .set({ state: "cancelled", reason: null, claimedAt: null, finishedAt: now, updatedAt: now })
        .where(and(eq(t.accountId, accountId), eq(t.id, id), inArray(t.state, ACTIVE)));
      return changedRows(cancelled) > 0;
    },
  };
}

/**
 * The merges a sweep moves, across accounts, oldest first: waiting ones
 * untouched for `idleMs`, and running ones whose claim lapsed.
 */
export function dueStackMerges(db: Db, now: Date, idleMs: number, limit: number) {
  const t = stackMerges;
  const idle = new Date(now.getTime() - idleMs);
  const lapsed = new Date(now.getTime() - STACK_LEASE_MS);
  return db
    .select({ id: t.id, accountId: t.accountId, platform: t.platform, host: t.host })
    .from(t)
    .where(
      or(
        and(eq(t.state, "waiting"), lt(t.updatedAt, idle)),
        and(eq(t.state, "running"), lt(t.updatedAt, lapsed)),
      ),
    )
    .orderBy(asc(t.updatedAt))
    .limit(limit);
}
