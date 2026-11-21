import { AsyncLocalStorage } from "node:async_hooks";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { asDb, type Transact } from "../src/node/postgres.js";

/** The server's Postgres database (src/node/postgres.ts) over PGlite, Postgres in this process. */
export async function openPglite(client: PGlite, migrations: string) {
  const inBatch = new AsyncLocalStorage<Pick<PGlite, "query" | "exec">>();
  const query = client.query.bind(client);
  client.query = ((...args: Parameters<PGlite["query"]>) =>
    (inBatch.getStore()?.query ?? query)(...args)) as PGlite["query"];
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: migrations });
  const transact: Transact = <T>(work: () => Promise<T>) =>
    client.transaction((tx) => inBatch.run(tx, work)) as Promise<T>;
  return asDb(db, transact);
}
