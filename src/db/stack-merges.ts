import { and, asc, desc, eq, inArray, isNotNull, lt, not, notInArray, or } from "drizzle-orm";
import type { StackMergeReason, StackMergeState } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { isUniqueViolation, jsonHoldsNumber } from "./dialect.js";
import { stackMergeLayers, stackMerges } from "./schema.js";

// The account's stack merges (reached through scoped()). One row per stack
// bottom, replaced once the last one ended, and one merge under way per
// pull request: a merge is inserted together with a row for each layer of
// its chain (stack_merge_layers, unique per pull request), so of two starts
// whose chains share a layer the database takes one, whatever bottom each
// read; the rows go in the statement batch that ends the merge. Each step
// is taken by the one caller whose compare-and-set moved the row from
// waiting to running, and a lease that lapsed (a runner that died) can be
// taken again. A cancel moves the row out of running, so the runner's next
// write, which names its claim, changes nothing.

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

/** A start's answer: the merge it made, or the one under way that holds a layer of its chain. */
export type StackStart = { merge: StackMerge; started: boolean };

export function accountStackMerges(db: Db, accountId: string) {
  const t = stackMerges;
  const l = stackMergeLayers;
  const underWay = db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.accountId, accountId), inArray(t.state, ACTIVE)));
  /** Gives up the layers of a merge that is no longer under way; run in the batch that ends it. */
  const letGo = (id: string) =>
    db
      .delete(l)
      .where(and(eq(l.accountId, accountId), eq(l.mergeId, id), notInArray(l.mergeId, underWay)));
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
    /** The newest merge whose chain holds `number`, whichever layer it is and whatever merged below it. */
    holding: (key: StackKey, number: number): Promise<StackMerge | undefined> =>
      db
        .select()
        .from(t)
        .where(and(ofRepo(key), jsonHoldsNumber(db, t.chain, "number", number)))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(1)
        .then(first),

    /** The merge under way that holds one of `numbers`, the oldest if a stack's earlier rows left several. */
    heldBy: (key: StackKey, numbers: readonly number[]): Promise<StackMerge | undefined> =>
      db
        .select()
        .from(t)
        .where(
          and(
            ofRepo(key),
            inArray(t.state, ACTIVE),
            or(...numbers.map((n) => jsonHoldsNumber(db, t.chain, "number", n))),
          ),
        )
        .orderBy(asc(t.createdAt), asc(t.id))
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
     * Starts a merge of the stack unless one under way holds a layer of its
     * chain, which is then the one answered. The merge and its layers go in
     * one batch: a layer another start took meanwhile fails all of it.
     */
    async start(merge: Starting, now: Date): Promise<StackStart | undefined> {
      const [layer] = merge.chain;
      if (!layer) return undefined;
      const numbers = merge.chain.map((c) => c.number);
      const fullName = stackPath(merge.fullName);
      const place = { accountId, platform: merge.platform, host: merge.host, fullName };
      // Lost twice only when the holder ended between the refusal and its read.
      for (let tries = 0; tries < 2; tries++) {
        const held = await this.heldBy(merge, numbers);
        if (held) return { merge: held, started: false };
        const id = crypto.randomUUID();
        try {
          await db.batch([
            // Layers a merge that ended some other way left behind hold nothing.
            db
              .delete(l)
              .where(
                and(
                  eq(l.accountId, accountId),
                  eq(l.platform, merge.platform),
                  eq(l.host, merge.host),
                  eq(l.fullName, fullName),
                  inArray(l.number, numbers),
                  notInArray(l.mergeId, underWay),
                ),
              ),
            // The stack's last merge ended: this one takes its place.
            db
              .delete(t)
              .where(and(ofRepo(merge), eq(t.bottom, merge.bottom), not(inArray(t.state, ACTIVE)))),
            db.insert(t).values({
              ...place,
              id,
              path: merge.fullName,
              bottom: merge.bottom,
              trunk: merge.trunk,
              method: merge.method,
              chain: merge.chain,
              step: 0,
              current: layer.number,
              head: layer.head,
              restacked: [],
              startedBy: merge.startedBy,
              state: "waiting",
              createdAt: now,
              updatedAt: now,
            }),
            db.insert(l).values(
              numbers.map((number) => ({
                ...place,
                id: crypto.randomUUID(),
                mergeId: id,
                number,
              })),
            ),
          ]);
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          continue;
        }
        const started = await this.byId(id);
        return started && { merge: started, started: true };
      }
      return undefined;
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
      const [done] = await db.batch([
        db
          .update(t)
          .set({ state, reason, claimedAt: null, finishedAt: now, updatedAt: now })
          .where(claimedBy(id, claim)),
        letGo(id),
      ]);
      return changedRows(done) > 0;
    },

    /** Cancels a merge under way; a step already sent to the platform is not undone. */
    async cancel(id: string, now: Date): Promise<boolean> {
      const [cancelled] = await db.batch([
        db
          .update(t)
          .set({
            state: "cancelled",
            reason: null,
            claimedAt: null,
            finishedAt: now,
            updatedAt: now,
          })
          .where(and(eq(t.accountId, accountId), eq(t.id, id), inArray(t.state, ACTIVE))),
        letGo(id),
      ]);
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
