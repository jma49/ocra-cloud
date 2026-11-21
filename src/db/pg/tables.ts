import { getTableName, is, SQL, sql } from "drizzle-orm";
import {
  bigint,
  customType,
  doublePrecision,
  foreignKey,
  index,
  type PgColumnBuilderBase,
  type PgTable,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";

// The Postgres tables of a self-hosted server, made from the SQLite ones in
// ../schema.ts, which stay the one schema. Each column keeps its SQLite
// storage: every integer (timestamps in milliseconds and booleans as 0 or 1
// included) a bigint, JSON as text. So the queries, written against the
// SQLite tables, read and write the same values on either database; these
// tables only give drizzle-kit the DDL of migrations-pg/.

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** SQLite's `unixepoch('subsec') * 1000`, the created_at default. */
const NOW_MS = sql`(floor(extract(epoch from clock_timestamp()) * 1000)::bigint)`;

function columnOf(column: SQLiteColumn): PgColumnBuilderBase {
  let built: ReturnType<typeof text> | ReturnType<typeof bigint> | ReturnType<typeof bytea>;
  switch (column.columnType) {
    case "SQLiteText":
    case "SQLiteTextJson":
      built = text(column.name);
      break;
    case "SQLiteInteger":
    case "SQLiteTimestamp":
    case "SQLiteBoolean":
      built = bigint(column.name, { mode: "number" });
      break;
    case "SQLiteReal":
      return withConstraints(doublePrecision(column.name), column);
    case "SQLiteBlobBuffer":
      built = bytea(column.name);
      break;
    default:
      throw new Error(`no Postgres column for ${column.columnType} (${column.name})`);
  }
  return withConstraints(built, column);
}

// biome-ignore lint/suspicious/noExplicitAny: each pg builder has its own default type
function withConstraints(built: any, column: SQLiteColumn): PgColumnBuilderBase {
  let out = built;
  if (column.primary) out = out.primaryKey();
  if (column.notNull && !column.primary) out = out.notNull();
  if (column.isUnique) out = out.unique(column.uniqueName);
  if (column.hasDefault && column.default !== undefined) {
    if (is(column.default, SQL)) {
      const text = column.default.queryChunks
        .map((c) => String((c as { value?: unknown }).value ?? ""))
        .join("");
      if (!text.includes("unixepoch('subsec')"))
        throw new Error(`no Postgres default for ${column.name}: ${text}`);
      out = out.default(NOW_MS);
    } else {
      out = out.default(column.mapToDriverValue(column.default));
    }
  }
  return out;
}

/** The Postgres table with the SQLite table's name, columns, keys and indexes. */
export function postgresTable(table: SQLiteTable, tables: Map<SQLiteTable, PgTable>): PgTable {
  const config = getTableConfig(table);
  const columns = Object.fromEntries(
    Object.entries(table).flatMap(([key, value]) =>
      config.columns.includes(value as SQLiteColumn)
        ? [[key, columnOf(value as SQLiteColumn)]]
        : [],
    ),
  );
  const keyOf = new Map(
    Object.entries(columns).map(([key]) => [
      (table as unknown as Record<string, SQLiteColumn>)[key]?.name,
      key,
    ]),
  );
  const made = pgTable(config.name, columns, (t) => {
    const col = (c: SQLiteColumn) => {
      const key = keyOf.get(c.name);
      if (!key) throw new Error(`no column ${c.name} in ${config.name}`);
      return (t as unknown as Record<string, never>)[key];
    };
    const part = (c: SQLiteColumn | SQL) => (is(c, SQL) ? c : col(c));
    return [
      ...config.primaryKeys.map((pk) =>
        primaryKey({ columns: pk.columns.map(col) as [never, ...never[]] }),
      ),
      ...config.indexes.map((i) => {
        const on = i.config.columns.map((c) => part(c as SQLiteColumn | SQL)) as [
          never,
          ...never[],
        ];
        return (i.config.unique ? uniqueIndex(i.config.name) : index(i.config.name)).on(...on);
      }),
      ...config.foreignKeys.map((fk) => {
        const ref = fk.reference();
        const target = tables.get(ref.foreignTable);
        if (!target)
          throw new Error(
            `${config.name} references ${getTableName(ref.foreignTable)} before it is made`,
          );
        const targetColumns = getTableConfigPg(target);
        return foreignKey({
          name: fk.getName(),
          columns: ref.columns.map(col) as [never, ...never[]],
          foreignColumns: ref.foreignColumns.map((c) => targetColumns(c.name)) as [
            never,
            ...never[],
          ],
        }).onDelete(fk.onDelete ?? "no action");
      }),
    ];
  });
  tables.set(table, made);
  return made;
}

function getTableConfigPg(table: PgTable) {
  const byName = new Map(
    Object.values(table as unknown as Record<string, { name?: string }>).flatMap((c) =>
      c && typeof c === "object" && "name" in c && "columnType" in c ? [[c.name, c]] : [],
    ),
  );
  return (name: string) => {
    const c = byName.get(name);
    if (!c) throw new Error(`no column ${name}`);
    return c as never;
  };
}
