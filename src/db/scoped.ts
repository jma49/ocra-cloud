import {
  and,
  count,
  desc,
  eq,
  gte,
  type InferInsertModel,
  type InferSelectModel,
  lte,
  sql,
} from "drizzle-orm";
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
    /** Returns whether a row of this account was deleted. */
    async remove(name: Name, id: string): Promise<boolean> {
      const result = await db.delete(accountTables[name]).where(byId(name, id)).run();
      return result.meta.changes > 0;
    },
  };
}

export type Scoped = ReturnType<typeof scoped>;
