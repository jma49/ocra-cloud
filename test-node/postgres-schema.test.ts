import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { getTableName, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as postgres from "../src/db/pg/schema.js";
import * as sqlite from "../src/db/schema.js";
import { openPglite } from "../test-pg/pglite.js";
import { freshPglite } from "./pglite-cluster.js";

// The Postgres migrations (migrations-pg/) make the tables the SQLite ones
// (migrations/) make, column for column and index for index: a schema change
// whose Postgres migration was not generated fails here. Columns compare as
// a set: SQLite appends a column a later migration adds, so the order of
// its columns is not the schema's.

type Shape = Record<string, { columns: string[]; indexes: string[] }>;

async function sqliteShape(): Promise<Shape> {
  const client = createClient({ url: ":memory:" });
  await migrate(drizzle(client), { migrationsFolder: resolve("migrations") });
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'",
  );
  const shape: Shape = {};
  for (const { name } of tables.rows) {
    const table = String(name);
    const columns = await client.execute(
      `SELECT name, "notnull", pk FROM pragma_table_info('${table}')`,
    );
    const indexes = await client.execute(
      `SELECT name FROM pragma_index_list('${table}') WHERE origin IN ('c', 'u') ORDER BY name`,
    );
    shape[table] = {
      columns: columns.rows.map((c) => `${c.name}${c.notnull || c.pk ? " not null" : ""}`).sort(),
      indexes: indexes.rows.map((i) => String(i.name)),
    };
  }
  client.close();
  return shape;
}

async function postgresShape(): Promise<Shape> {
  const client = await freshPglite();
  await openPglite(client, resolve("migrations-pg"));
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    is_nullable: string;
  }>(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const indexes = await client.query<{ tablename: string; indexname: string }>(
    `SELECT i.tablename, i.indexname FROM pg_indexes i
      WHERE i.schemaname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_constraint c
        WHERE c.conname = i.indexname AND c.contype = 'p')
      ORDER BY i.indexname`,
  );
  const shape: Shape = {};
  for (const c of columns.rows) {
    shape[c.table_name] ??= { columns: [], indexes: [] };
    shape[c.table_name]?.columns.push(
      `${c.column_name}${c.is_nullable === "NO" ? " not null" : ""}`,
    );
  }
  for (const i of indexes.rows) shape[i.tablename]?.indexes.push(i.indexname);
  for (const table of Object.values(shape)) table.columns.sort();
  await client.close();
  return shape;
}

describe("the Postgres schema", () => {
  it("has a table for every SQLite one", () => {
    const names = (module: Record<string, unknown>, isTable: (v: unknown) => boolean) =>
      Object.entries(module)
        .filter(([, v]) => isTable(v))
        .map(([key]) => key)
        .sort();
    const sqliteTables = names(sqlite, (v) => is(v, SQLiteTable));
    expect(names(postgres, (v) => v !== null && typeof v === "object")).toEqual(sqliteTables);
    const table = (module: object, key: string) =>
      (module as Record<string, Parameters<typeof getTableName>[0]>)[key] as never;
    for (const key of sqliteTables) {
      expect(getTableName(table(postgres, key))).toBe(getTableName(table(sqlite, key)));
    }
  });

  it("is what the SQLite migrations make, from the Postgres migrations", async () => {
    const [lite, pg] = await Promise.all([sqliteShape(), postgresShape()]);
    expect(pg).toEqual(lite);
  });
});
