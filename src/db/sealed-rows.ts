import { type SQL, sql } from "drizzle-orm";
import { REWRAP_BATCH, type SealedKind, type SealedStore } from "../crypto.js";
import type { Db } from "./client.js";
import { rawRows } from "./dialect.js";

// The sealed rows of every account, for a master key rotation on a
// self-hosted server (src/node/rewrap-master-key.ts): the one reader of
// these tables across accounts, so it is here and not behind scoped().

type Key = unknown[];

const ids = (names: string[]) =>
  sql.join(
    names.map((n) => sql.identifier(n)),
    sql`, `,
  );
const tuple = (values: unknown[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** A row's primary key equals `key`. */
const at = (kind: SealedKind, key: Key): SQL =>
  sql.join(
    kind.key.map((n, i) => sql`${sql.identifier(n)} = ${key[i]}`),
    sql` AND `,
  );

/** The sealed rows of the database every query takes, found again by their primary key. */
export function databaseSealedStore(db: Db): SealedStore<Key> {
  return {
    async *pages(kind) {
      const table = sql.identifier(kind.table);
      const wrapped = sql.identifier(kind.wrapped);
      const columns = [...new Set([...kind.key, kind.wrapped, kind.ciphertext, ...kind.columns])];
      for (let after: Key | undefined; ; ) {
        // Keyset paging on the primary key; a row value compares on SQLite and Postgres alike.
        const past = after ? sql` AND (${ids(kind.key)}) > (${tuple(after)})` : sql``;
        const rows = await rawRows<Record<string, unknown>>(
          db,
          sql`SELECT ${ids(columns)} FROM ${table} WHERE ${wrapped} IS NOT NULL${past} ORDER BY ${ids(kind.key)} LIMIT ${REWRAP_BATCH}`,
        );
        const page = rows.map((values) => ({ ref: kind.key.map((n) => values[n]), values }));
        if (page.length > 0) yield page;
        if (page.length < REWRAP_BATCH) return;
        after = page.at(-1)?.ref;
      }
    },
    async write(kind, updates) {
      const table = sql.identifier(kind.table);
      const wrapped = sql.identifier(kind.wrapped);
      // Matching the old wrapped key leaves alone a row the service rewrote in between.
      const statements = updates.map((u) =>
        db.run(
          sql`UPDATE ${table} SET ${wrapped} = ${u.to} WHERE ${at(kind, u.ref)} AND ${wrapped} = ${u.from}`,
        ),
      );
      if (statements.length > 0) await db.batch(statements as never);
    },
    label: (ref) => `row ${ref.map(String).join("/")}`,
  };
}
