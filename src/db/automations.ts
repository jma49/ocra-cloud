import { eq, sql } from "drizzle-orm";
import { changedRows, type Db } from "./client.js";
import { automationRules, automationRuns } from "./schema.js";

// The account's automation rules and their runs (reached through scoped()):
// a rule is added in one statement under the cap, and a run claims its
// rule's event by the unique index before any action is taken.

type NewRule = Omit<typeof automationRules.$inferInsert, "accountId" | "createdAt" | "updatedAt">;
type NewRun = Omit<typeof automationRuns.$inferInsert, "accountId" | "createdAt" | "outcome">;

export function accountAutomations(db: Db, accountId: string) {
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
      const t = automationRuns;
      const result = await db
        .insert(t)
        .values({ ...row, accountId })
        .onConflictDoNothing({ target: [t.ruleId, t.eventKey] });
      return changedRows(result) > 0;
    },
  };
}
