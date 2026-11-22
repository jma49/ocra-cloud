import { eq, sql } from "drizzle-orm";
import { changedRows, type Db } from "./client.js";
import { notifyChannels } from "./schema.js";

// The account's chat channels (reached through scoped()): added in one
// statement under the cap, so parallel adds cannot pass a count taken first.

type NewChannel = Omit<typeof notifyChannels.$inferInsert, "accountId" | "createdAt">;

export function accountNotify(db: Db, accountId: string) {
  const t = notifyChannels;
  return {
    /** Adds the channel unless the account has cap already; whether it did. */
    async add(row: NewChannel & { id: string }, cap: number): Promise<boolean> {
      const inserted = await db.insert(t).select(sql`
        SELECT ${row.id}, ${accountId}, ${row.kind}, ${row.name}, ${row.when},
          ${row.wrappedKey}, ${row.ciphertext}, ${row.last4}, NULL, NULL, ${Date.now()}
        WHERE (SELECT count(*) FROM ${t} WHERE ${eq(t.accountId, accountId)}) < ${cap}`);
      return changedRows(inserted) > 0;
    },
  };
}
