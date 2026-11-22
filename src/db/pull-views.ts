import type { Verdict } from "@open-cr-agent/cloud-contract";
import { and, eq, ne, notExists, sql } from "drizzle-orm";
import type { PullFilters, PullViewDraft } from "../shared/index.js";
import { changedRows, type Db } from "./client.js";
import { jsonRecords, randomId } from "./dialect.js";
import { pullViews, reviews } from "./schema.js";

// The account's inbox sections and what the inbox reads about each listed
// pull request: the newest verdict of the account's reviews of it. Reached
// only through scoped().

type Changes = { name?: string; filters?: PullFilters; position?: number; hidden?: boolean };

export function accountPullViews(db: Db, accountId: string) {
  const t = pullViews;
  const named = (name: string) => and(eq(t.accountId, accountId), eq(t.name, name));
  return {
    /**
     * Adds a view after the account's last one, only while it has fewer than
     * cap and none of that name; its id, or why not.
     */
    async add(
      view: PullViewDraft,
      cap: number,
    ): Promise<{ id: string } | { refused: "full" | "taken" }> {
      const id = crypto.randomUUID();
      const added = await db.run(sql`
        INSERT INTO ${t} (id, account_id, name, filters, position)
        SELECT ${id}, ${accountId}, ${view.name}, ${JSON.stringify(view.filters)},
          coalesce((SELECT max(position) + 1 FROM ${t} WHERE account_id = ${accountId}), 0)
        WHERE (SELECT count(*) FROM ${t} WHERE account_id = ${accountId}) < ${cap}
        ON CONFLICT (account_id, name) DO NOTHING`);
      if (changedRows(added) > 0) return { id };
      const taken = await db.select({ id: t.id }).from(t).where(named(view.name)).limit(1);
      return { refused: taken.length > 0 ? "taken" : "full" };
    },

    /** Changes one view; a new name another of the account's views has is refused. */
    async change(id: string, changes: Changes): Promise<"changed" | "not_found" | "taken"> {
      const own = and(eq(t.accountId, accountId), eq(t.id, id));
      const free =
        changes.name === undefined
          ? undefined
          : notExists(
              db
                .select({ id: t.id })
                .from(t)
                .where(and(named(changes.name), ne(t.id, id))),
            );
      const result = await db.update(t).set(changes).where(and(own, free));
      if (changedRows(result) > 0) return "changed";
      const mine = await db.select({ id: t.id }).from(t).where(own).limit(1);
      return mine.length > 0 ? "taken" : "not_found";
    },

    /** Keeps these drafts as the account's views, in order, only while it has none; how many it added. */
    async keepDefaults(drafts: readonly PullViewDraft[]): Promise<number> {
      const rows = JSON.stringify(
        drafts.map((d, position) => ({
          name: d.name,
          filters: JSON.stringify(d.filters),
          position,
        })),
      );
      const added = await db.run(sql`
        INSERT INTO ${t} (id, account_id, name, filters, position)
        SELECT ${randomId(db)}, ${accountId}, je.name, je.filters, je.position
        FROM ${jsonRecords(db, rows, { name: "text", filters: "text", position: "bigint" })}
        WHERE NOT EXISTS (SELECT 1 FROM ${t} WHERE account_id = ${accountId})
        ON CONFLICT (account_id, name) DO NOTHING`);
      return changedRows(added);
    },

    /**
     * The verdict of the account's newest review of each pull request named
     * by its repository identity (lower case) and number, that has one.
     */
    async verdicts(pulls: readonly { repo: string; number: number }[]) {
      if (pulls.length === 0) return [];
      const r = reviews;
      const list = JSON.stringify(pulls);
      const rows = await db
        .select({
          repo: sql<string>`je.repo`,
          number: sql<number>`je.number`,
          verdict: sql<Verdict | null>`(SELECT ${r.verdict} FROM ${r}
            WHERE ${r.accountId} = ${accountId} AND ${r.prNumber} = je.number
              AND lower(${r.prRepository}) = je.repo AND ${r.verdict} IS NOT NULL
            ORDER BY ${r.createdAt} DESC LIMIT 1)`,
        })
        .from(jsonRecords(db, list, { repo: "text", number: "bigint" }));
      return rows.flatMap((row) =>
        row.verdict ? [{ repo: row.repo, number: Number(row.number), verdict: row.verdict }] : [],
      );
    },
  };
}
