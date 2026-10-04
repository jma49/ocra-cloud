import {
  and,
  count,
  desc,
  eq,
  gte,
  type InferInsertModel,
  type InferSelectModel,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { accountTables } from "./schema.js";

type Tables = typeof accountTables;
type Name = keyof Tables;
type Row<N extends Name> = InferSelectModel<Tables[N]>;
type NewRow<N extends Name> = Omit<InferInsertModel<Tables[N]>, "accountId">;
type Changes<N extends Name> = Partial<Omit<NewRow<N>, "id">>;

/**
 * The one way to read and write an account's rows: every query filters by
 * the account, and every insert sets it. Code outside src/db/ does not
 * import the tables.
 */
export function scoped(db: DrizzleD1Database, accountId: string) {
  const own = (name: Name) => eq(accountTables[name].accountId, accountId);
  const byId = (name: Name, id: string) => and(own(name), eq(accountTables[name].id, id));
  // Unrun statements for batch(), scoped like the methods below.
  const writes = {
    insert<N extends Name>(name: N, row: NewRow<N>): BatchItem<"sqlite"> {
      return db.insert(accountTables[name]).values({ ...row, accountId } as never);
    },
    update<N extends Name>(name: N, id: string, changes: Changes<N>): BatchItem<"sqlite"> {
      const { accountId: _ignored, ...rest } = changes as Record<string, unknown>;
      return db
        .update(accountTables[name])
        .set(rest as never)
        .where(byId(name, id));
    },
    /** Deletes this account's rows beyond the newest keep. */
    keepNewest(name: Name, keep: number): BatchItem<"sqlite"> {
      const t = accountTables[name];
      const newest = db
        .select({ id: t.id })
        .from(t)
        .where(own(name))
        .orderBy(desc(t.createdAt))
        .limit(keep);
      return db.delete(t).where(and(own(name), notInArray(t.id, newest)));
    },
  };
  return {
    accountId,
    list<N extends Name>(name: N): Promise<Row<N>[]> {
      // The generic table loses drizzle's row type; the row is the table's.
      return db.select().from(accountTables[name]).where(own(name)).all() as Promise<Row<N>[]>;
    },
    async get<N extends Name>(name: N, id: string): Promise<Row<N> | undefined> {
      return (await db.select().from(accountTables[name]).where(byId(name, id)).get()) as
        | Row<N>
        | undefined;
    },
    async insert<N extends Name>(name: N, row: NewRow<N>): Promise<void> {
      await db.insert(accountTables[name]).values({ ...row, accountId } as never);
    },
    /** This account's rows created at or after since, newest first. */
    listSince<N extends Name>(name: N, since: Date, limit = 10_000): Promise<Row<N>[]> {
      const t = accountTables[name];
      return db
        .select()
        .from(t)
        .where(and(own(name), gte(t.createdAt, since)))
        .orderBy(desc(t.createdAt))
        .limit(limit)
        .all() as Promise<Row<N>[]>;
    },
    /** Rows of this account created at or after since. */
    async countSince(name: Name, since: Date): Promise<number> {
      const t = accountTables[name];
      const row = await db
        .select({ n: count() })
        .from(t)
        .where(and(own(name), gte(t.createdAt, since)))
        .get();
      return row?.n ?? 0;
    },
    /**
     * Inserts a row, then keeps it only if at most cap rows of this account
     * created since then were inserted up to and including it (in rowid
     * order, which D1 assigns one insert at a time). The insert is the
     * reservation, so parallel callers cannot all pass a count taken before
     * any of them wrote. Returns whether the row was kept.
     */
    async reserve<N extends Name>(
      name: N,
      row: NewRow<N> & { id: string },
      since: Date,
      cap: number,
    ): Promise<boolean> {
      const t = accountTables[name];
      const seq = sql<number>`rowid`;
      const [mine] = await db
        .insert(t)
        .values({ ...row, accountId } as never)
        .returning({ seq });
      if (!mine) return false;
      const ahead = await db
        .select({ n: count() })
        .from(t)
        .where(and(own(name), gte(t.createdAt, since), lte(seq, mine.seq)))
        .get();
      if ((ahead?.n ?? 0) <= cap) return true;
      await db.delete(t).where(byId(name, row.id)).run();
      return false;
    },
    /** Runs the statements built from writes in one D1 batch: all of them or none. */
    async batch(build: (w: typeof writes) => BatchItem<"sqlite">[]): Promise<void> {
      const [first, ...rest] = build(writes);
      if (first) await db.batch([first, ...rest]);
    },
    /** Returns whether a row of this account changed. */
    async update<N extends Name>(name: N, id: string, changes: Changes<N>): Promise<boolean> {
      const { accountId: _ignored, ...rest } = changes as Record<string, unknown>;
      if (Object.keys(rest).length === 0) return false;
      const result = await db
        .update(accountTables[name])
        .set(rest as never)
        .where(byId(name, id))
        .run();
      return result.meta.changes > 0;
    },
    /**
     * Stores a review and its findings atomically, unless this account already
     * has the review's run: then nothing is written and the stored review's id
     * comes back. The findings go in as one statement over a JSON array, so
     * the number of D1 queries does not grow with them.
     *
     * Limits are checked inside the same batch, which D1 runs as one
     * transaction, so concurrent uploads cannot all pass a count taken before
     * any of them wrote. A review past dailyUploads (counting rows created
     * since `since`) is removed again and `limited` comes back. Findings that
     * would take the account past maxFindings are not stored, and
     * `findingsSkipped` comes back; the review itself is kept.
     */
    async insertReview(
      review: NewRow<"reviews"> & { id: string },
      list: Omit<NewRow<"findings">, "id" | "reviewId">[],
      limits: { since: Date; dailyUploads: number; maxFindings: number },
    ): Promise<{ id: string; duplicate: boolean; limited: boolean; findingsSkipped: boolean }> {
      const r = accountTables.reviews;
      const insert = db
        .insert(r)
        .values({ ...review, accountId })
        .onConflictDoNothing({ target: [r.accountId, r.runId] });
      // Removes this upload's row again when it is past the day's cap.
      const overCap = db.delete(r).where(
        and(
          eq(r.id, review.id),
          eq(r.accountId, accountId),
          sql`(SELECT count(*) FROM reviews WHERE account_id = ${accountId}
            AND created_at >= ${limits.since.getTime()}) > ${limits.dailyUploads}`,
        ),
      );
      const rows = JSON.stringify(list.map((f) => ({ ...f, id: crypto.randomUUID() })));
      // Only when the review row above was this upload's own and kept, and
      // all of its findings fit under the account's cap.
      // In the table's column order: insert … select names every column.
      const findings = db.insert(accountTables.findings).select(sql`
        SELECT json_extract(value, '$.id'), ${accountId}, ${review.id},
          json_extract(value, '$.fingerprint'), json_extract(value, '$.reviewer'),
          json_extract(value, '$.severity'), json_extract(value, '$.category'),
          json_extract(value, '$.verification'), json_extract(value, '$.file'),
          json_extract(value, '$.lineStart'), json_extract(value, '$.lineEnd'),
          json_extract(value, '$.title'), json_extract(value, '$.body'),
          json_extract(value, '$.suggestion'), json_extract(value, '$.code'),
          coalesce(json_extract(value, '$.redacted'), 0),
          coalesce(json_extract(value, '$.truncated'), 0),
          unixepoch('subsec') * 1000
        FROM json_each(${rows})
        WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ${review.id} AND account_id = ${accountId})
          AND (SELECT count(*) FROM findings WHERE account_id = ${accountId})
            + ${list.length} <= ${limits.maxFindings}`);
      const [stored, removed, kept] =
        list.length > 0
          ? await db.batch([insert, overCap, findings])
          : await db.batch([insert, overCap]);
      if (stored.meta.changes > 0) {
        const limited = removed.meta.changes > 0;
        return {
          id: review.id,
          duplicate: false,
          limited,
          findingsSkipped: !limited && list.length > 0 && (kept?.meta.changes ?? 0) === 0,
        };
      }
      const existing = await db
        .select({ id: r.id })
        .from(r)
        .where(and(eq(r.accountId, accountId), eq(r.runId, review.runId)))
        .get();
      return {
        id: existing?.id ?? review.id,
        duplicate: true,
        limited: false,
        findingsSkipped: false,
      };
    },
    /** Deletes every row of this account in a table; returns how many. */
    async removeAll(name: Name): Promise<number> {
      const result = await db.delete(accountTables[name]).where(own(name)).run();
      return result.meta.changes;
    },
    /** Returns whether a row of this account was deleted. */
    async remove(name: Name, id: string): Promise<boolean> {
      const result = await db.delete(accountTables[name]).where(byId(name, id)).run();
      return result.meta.changes > 0;
    },
  };
}

export type Scoped = ReturnType<typeof scoped>;
