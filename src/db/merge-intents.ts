import { and, asc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { MergeIntentReason, MergeIntentState } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { mergeIntents, reviewRepos } from "./schema.js";

// The account's merge-when-ready intents (reached through scoped()). One
// row per pull request, armed again in place; the merge is taken by the
// one caller whose compare-and-set moved the row from armed to merging,
// and a lease that lapsed (a runner that died) can be taken again.

export type MergeIntent = typeof mergeIntents.$inferSelect;

export type PullKey = { platform: MergeIntent["platform"]; host: string; fullName: string };

type Arming = PullKey &
  Pick<MergeIntent, "number" | "method" | "mode" | "head" | "keepOnPush" | "armedBy">;

/** How long a merge may hold its claim before another runner may take it. */
export const MERGE_LEASE_MS = 5 * 60_000;

/** The repository's path as rows hold it: platforms read paths without case. */
const intentPath = (fullName: string) => fullName.toLowerCase();

export function accountMergeIntents(db: Db, accountId: string) {
  const t = mergeIntents;
  const ofPull = (key: PullKey) =>
    and(
      eq(t.accountId, accountId),
      eq(t.platform, key.platform),
      eq(t.host, key.host),
      eq(t.fullName, intentPath(key.fullName)),
    );
  const claimedBy = (id: string, claim: Date) =>
    and(eq(t.accountId, accountId), eq(t.id, id), eq(t.state, "merging"), eq(t.claimedAt, claim));
  return {
    of: (key: PullKey, number: number): Promise<MergeIntent | undefined> =>
      db
        .select()
        .from(t)
        .where(and(ofPull(key), eq(t.number, number)))
        .limit(1)
        .then(first),

    /**
     * The intents a webhook concerns, armed or held by a merge (whose lapsed
     * claim may be taken over): of one pull request, or of the commit it names.
     */
    active(key: PullKey, at: { number: number } | { head: string }, limit = 20) {
      const which = "number" in at ? eq(t.number, at.number) : eq(t.head, at.head);
      return db
        .select()
        .from(t)
        .where(and(ofPull(key), which, inArray(t.state, ["armed", "merging"])))
        .limit(limit);
    },

    /**
     * Arms the pull request, replacing an earlier intent of it unless a
     * merge of it is under way (and its claim has not lapsed); the row as it
     * now stands.
     */
    async arm(intent: Arming, now: Date): Promise<MergeIntent | undefined> {
      const fields = {
        method: intent.method,
        mode: intent.mode,
        head: intent.head,
        keepOnPush: intent.keepOnPush,
        armedBy: intent.armedBy,
        state: "armed" as const,
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
          platform: intent.platform,
          host: intent.host,
          fullName: intentPath(intent.fullName),
          number: intent.number,
          ...fields,
        })
        .onConflictDoUpdate({
          target: [t.accountId, t.platform, t.host, t.fullName, t.number],
          set: fields,
          // The conflict is on a key that starts with the account: the row is its own.
          // A merge whose claim lapsed (its runner died) is armed again.
          setWhere: sql`(${t.state} <> 'merging' OR ${t.claimedAt} < ${now.getTime() - MERGE_LEASE_MS})`,
        });
      return this.of(intent, intent.number);
    },

    /**
     * Takes the merge of an armed intent at head; the claim, for one caller,
     * or null. A claim older than the lease is taken over.
     */
    async claim(id: string, head: string, now: Date): Promise<Date | null> {
      const lapsed = new Date(now.getTime() - MERGE_LEASE_MS);
      const taken = await db
        .update(t)
        .set({ state: "merging", claimedAt: now, updatedAt: now })
        .where(
          and(
            eq(t.accountId, accountId),
            eq(t.id, id),
            eq(t.head, head),
            or(
              eq(t.state, "armed"),
              and(eq(t.state, "merging"), isNotNull(t.claimedAt), lt(t.claimedAt, lapsed)),
            ),
          ),
        );
      return changedRows(taken) > 0 ? now : null;
    },

    /** Gives a claim back, still armed, saying what it waits on (and at which head). */
    async release(
      id: string,
      claim: Date,
      reason: MergeIntentReason,
      now: Date,
      head?: string,
    ): Promise<boolean> {
      const back = await db
        .update(t)
        .set({
          state: "armed",
          reason,
          claimedAt: null,
          updatedAt: now,
          ...(head ? { head } : {}),
        })
        .where(claimedBy(id, claim));
      return changedRows(back) > 0;
    },

    /**
     * Gives a claim back as the intent was before it (what it waited on, when
     * it was last read): one the run's calls cut short was not read, so the
     * next sweep takes it first.
     */
    async giveBack(
      id: string,
      claim: Date,
      was: Pick<MergeIntent, "reason" | "updatedAt">,
    ): Promise<boolean> {
      const back = await db
        .update(t)
        .set({ state: "armed", reason: was.reason, claimedAt: null, updatedAt: was.updatedAt })
        .where(claimedBy(id, claim));
      return changedRows(back) > 0;
    },

    /** Ends an intent the caller claimed; whether it was still its claim. */
    async finish(
      id: string,
      claim: Date,
      state: Exclude<MergeIntentState, "armed" | "merging">,
      reason: MergeIntentReason | null,
      now: Date,
    ): Promise<boolean> {
      const done = await db
        .update(t)
        .set({ state, reason, claimedAt: null, finishedAt: now, updatedAt: now })
        .where(claimedBy(id, claim));
      return changedRows(done) > 0;
    },

    /**
     * Ends or moves an armed intent nobody claimed: compare-and-set on its
     * state and head, so a webhook and a merge racing it change it once.
     */
    async settle(
      id: string,
      head: string,
      change:
        | {
            state: Exclude<MergeIntentState, "armed" | "merging">;
            reason: MergeIntentReason | null;
          }
        | { head: string },
      now: Date,
    ): Promise<boolean> {
      const set =
        "state" in change
          ? { state: change.state, reason: change.reason, finishedAt: now, updatedAt: now }
          : { head: change.head, reason: null, updatedAt: now };
      const moved = await db
        .update(t)
        .set(set)
        .where(
          and(eq(t.accountId, accountId), eq(t.id, id), eq(t.head, head), eq(t.state, "armed")),
        );
      return changedRows(moved) > 0;
    },
  };
}

/**
 * The intents a sweep reads again, across accounts, those untouched longest
 * first: server-kept ones on a repository still enrolled, armed and not
 * moved for `idleMs`, or held by a merge whose claim lapsed.
 */
export function dueMergeIntents(
  db: Db,
  now: Date,
  idleMs: number,
  limit: number,
): Promise<MergeIntent[]> {
  const t = mergeIntents;
  const r = reviewRepos;
  const idle = new Date(now.getTime() - idleMs);
  const lapsed = new Date(now.getTime() - MERGE_LEASE_MS);
  return db
    .select()
    .from(t)
    .where(
      and(
        eq(t.mode, "server"),
        or(
          and(eq(t.state, "armed"), lt(t.updatedAt, idle)),
          and(eq(t.state, "merging"), isNotNull(t.claimedAt), lt(t.claimedAt, lapsed)),
        ),
        sql`EXISTS (SELECT 1 FROM ${r} WHERE ${r.accountId} = ${t.accountId} AND ${r.platform} = ${t.platform} AND ${r.host} = ${t.host} AND lower(${r.fullName}) = ${t.fullName})`,
      ),
    )
    .orderBy(asc(t.updatedAt))
    .limit(limit);
}
