import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { Db } from "../db/client.js";
import { markPostgres } from "../db/dialect.js";

// Postgres as the database every query takes (../db/client.ts): the same
// Drizzle queries over the SQLite tables, whose values the Postgres columns
// store unchanged (../db/pg/tables.ts). What D1 and libSQL do natively is
// added here: a batch runs its statements in one transaction, on one
// connection, and a raw statement runs with `db.run`.

type Query = PromiseLike<unknown>;
export type Transact = <T>(work: () => Promise<T>) => Promise<T>;

/** The Drizzle database, with D1's batch and run, as every query takes it. */
export function asDb(db: { execute(q: unknown): Promise<unknown> }, transact: Transact): Db {
  const shaped = Object.assign(db, {
    batch: (queries: readonly Query[]) =>
      transact(async () => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      }),
    run: (q: unknown) => db.execute(q),
  });
  return markPostgres(shaped as unknown as Db);
}

// int8 (bigint) columns come back as numbers: every integer the app keeps
// (milliseconds, counts) is far below 2^53, as in SQLite.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);

/** A Postgres server (DATABASE_URL postgres://…), its migrations applied unless `migrate` is false. */
export async function openPostgres(url: string, options: { migrations: string; migrate: boolean }) {
  const pool = new pg.Pool({ connectionString: url });
  // A batch's statements, built on the pool, go to the batch's connection.
  const inBatch = new AsyncLocalStorage<pg.PoolClient>();
  const poolQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  pool.query = ((...args: unknown[]) => {
    const client = inBatch.getStore();
    return client ? (client.query as (...a: unknown[]) => unknown)(...args) : poolQuery(...args);
  }) as typeof pool.query;
  const db = drizzlePg(pool);
  if (options.migrate) await migratePg(db, { migrationsFolder: options.migrations });
  const transact: Transact = async (work) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await inBatch.run(client, work);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  return { db: asDb(db, transact), pool, close: () => void pool.end() };
}
