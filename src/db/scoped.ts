import { and, eq, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
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
