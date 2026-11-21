import { sql } from "drizzle-orm";
import type { PullFilters } from "../shared/index.js";
import { changedRows, type Db } from "./client.js";
import { pullViews } from "./schema.js";

/** Adds a view after the account's last one, only while it has fewer than cap; its id, or null. */
export async function addPullView(
  db: Db,
  accountId: string,
  view: { name: string; filters: PullFilters },
  cap: number,
): Promise<string | null> {
  const id = crypto.randomUUID();
  const t = pullViews;
  const added = await db.run(sql`
    INSERT INTO ${t} (id, account_id, name, filters, position)
    SELECT ${id}, ${accountId}, ${view.name}, ${JSON.stringify(view.filters)},
      coalesce((SELECT max(position) + 1 FROM ${t} WHERE account_id = ${accountId}), 0)
    WHERE (SELECT count(*) FROM ${t} WHERE account_id = ${accountId}) < ${cap}`);
  return changedRows(added) > 0 ? id : null;
}
