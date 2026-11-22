import { and, asc, eq, gte, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { AutomationRetry, AutomationRunView } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { automationRules, automationRuns } from "./schema.js";

// The account's automation rules and their runs (reached through scoped()):
// a rule is added in one statement under the cap, a run claims its rule's
// event by the unique index before any action is taken, and each attempt
// after the first is claimed by a compare-and-set on the run's attempts.

type NewRule = Omit<typeof automationRules.$inferInsert, "accountId" | "createdAt" | "updatedAt">;
type NewRun = Omit<
  typeof automationRuns.$inferInsert,
  "accountId" | "createdAt" | "attempts" | "retry" | "retryAt"
>;

/** What an attempt leaves: its actions' outcomes, and what is tried again when. */
export type RunResult = {
  outcome: "done" | "partial" | "failed";
  actions: AutomationRunView["actions"];
  retry: AutomationRetry | null;
  retryAt: Date | null;
};

export function accountAutomations(db: Db, accountId: string) {
  const r = automationRuns;
  return {
    /** Adds the rule unless the account has cap already; whether it did. */
    async add(row: NewRule & { id: string }, cap: number): Promise<boolean> {
      const t = automationRules;
      const now = Date.now();
      // A boolean is 0 or 1 on every database (./pg/tables.ts); a parameter is not cast.
      const inserted = await db.insert(t).select(sql`
        SELECT ${row.id}, ${accountId}, ${row.name}, ${row.enabled === false ? 0 : 1}, ${row.trigger},
          ${JSON.stringify(row.conditions)}, ${JSON.stringify(row.actions)}, ${now}, ${now}
        WHERE (SELECT count(*) FROM ${t} WHERE ${eq(t.accountId, accountId)}) < ${cap}`);
      return changedRows(inserted) > 0;
    },
    /** Records the run unless its rule ran on this event already; whether this one runs. */
    async claim(row: NewRun & { id: string }): Promise<boolean> {
      const result = await db
        .insert(r)
        .values({ ...row, accountId })
        .onConflictDoNothing({ target: [r.ruleId, r.eventKey] });
      return changedRows(result) > 0;
    },
    /** Records the attempt, only while it is still the one that claimed the run. */
    async finish(id: string, attempts: number, result: RunResult): Promise<void> {
      await db
        .update(r)
        .set(result)
        .where(and(eq(r.accountId, accountId), eq(r.id, id), eq(r.attempts, attempts)));
    },
  };
}

export type ClaimedRetry = {
  id: string;
  accountId: string;
  ruleName: string;
  attempts: number;
  actions: AutomationRunView["actions"];
  retry: AutomationRetry;
};

/**
 * Claims the run whose retry is due longest, its retryAt moved past the
 * lease so a runner that dies leaves it to the next; undefined when none is
 * due. A run due with no attempt left keeps the outcomes it has.
 */
export async function claimAutomationRetry(
  db: Db,
  now: Date,
  leaseMs: number,
  maxAttempts: number,
): Promise<ClaimedRetry | undefined> {
  const r = automationRuns;
  await db
    .update(r)
    .set({ retry: null, retryAt: null })
    .where(and(isNotNull(r.retryAt), lte(r.retryAt, now), gte(r.attempts, maxAttempts)));
  const due = await db
    .select({ id: r.id, attempts: r.attempts })
    .from(r)
    .where(and(isNotNull(r.retryAt), lte(r.retryAt, now)))
    .orderBy(asc(r.retryAt))
    .limit(1)
    .then(first);
  if (!due) return undefined;
  const [claimed] = await db
    .update(r)
    .set({ attempts: due.attempts + 1, retryAt: new Date(now.getTime() + leaseMs) })
    .where(and(eq(r.id, due.id), eq(r.attempts, due.attempts), lt(r.attempts, maxAttempts)))
    .returning({
      id: r.id,
      accountId: r.accountId,
      ruleName: r.ruleName,
      attempts: r.attempts,
      actions: r.actions,
      retry: r.retry,
    });
  if (!claimed?.retry) return undefined;
  return { ...claimed, retry: claimed.retry };
}
