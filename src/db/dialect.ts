import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import type { Db } from "./client.js";

// The few statements SQLite and Postgres write differently: reading JSON
// passed as one parameter, and a UTC day from milliseconds. Everything else
// the queries say is the same on both (../node/postgres.ts).

const POSTGRES = Symbol("postgres");

export function markPostgres<T extends Db>(db: T): T {
  return Object.assign(db, { [POSTGRES]: true });
}

const isPostgres = (db: Db) => POSTGRES in db;

/** How many rows of a group cond holds for: Postgres sums no boolean. */
export const countWhere = (cond: SQL): SQL<number> =>
  sql<number>`coalesce(sum(CASE WHEN ${cond} THEN 1 ELSE 0 END), 0)`;

/** The text elements of a JSON array of strings, for `IN (…)`. */
export function jsonTexts(db: Db, array: string): SQL {
  return isPostgres(db)
    ? sql`SELECT jsonb_array_elements_text(${array}::jsonb)`
    : sql`SELECT value FROM json_each(${array})`;
}

/**
 * A JSON array of objects as a table `je`, one column per named key. Only
 * text and integer values: a boolean goes in as 0 or 1.
 */
export function jsonRecords(
  db: Db,
  array: string,
  columns: Record<string, "text" | "bigint">,
): SQL {
  const names = Object.entries(columns);
  if (isPostgres(db)) {
    const typed = names.map(([name, type]) => sql`${sql.identifier(name)} ${sql.raw(type)}`);
    return sql`jsonb_to_recordset(${array}::jsonb) AS je(${sql.join(typed, sql`, `)})`;
  }
  const picked = names.map(
    ([name]) => sql`json_extract(value, ${`$.${name}`}) AS ${sql.identifier(name)}`,
  );
  return sql`(SELECT ${sql.join(picked, sql`, `)} FROM json_each(${array})) AS je`;
}

/** A JSON array's elements as text, as a table `je` of `value` (null for a JSON null). */
export function jsonElements(db: Db, array: SQL): SQL {
  return isPostgres(db)
    ? sql`jsonb_array_elements_text(${array}::jsonb) AS je(value)`
    : sql`json_each(${array}) AS je`;
}

/** A JSON object's members, as a table `je` of `key` and `value`. */
export function jsonMembers(db: Db, object: SQL): SQL {
  return isPostgres(db)
    ? sql`jsonb_each(${object}::jsonb) AS je(key, value)`
    : sql`json_each(${object}) AS je`;
}

/** The number at `path` (a.b) in a JSON value from jsonMembers. */
export function jsonNumber(db: Db, value: SQL, path: string): SQL {
  if (!isPostgres(db)) return sql`json_extract(${value}, ${`$.${path}`})`;
  return sql`(${value} #>> ${`{${path.split(".").join(",")}}`})::double precision`;
}

/** The UTC day (YYYY-MM-DD) of a time in milliseconds. */
export function utcDayOf(db: Db, ms: SQL): SQL<string> {
  return isPostgres(db)
    ? sql<string>`to_char(to_timestamp(${ms} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
    : sql<string>`strftime('%Y-%m-%d', ${ms} / 1000, 'unixepoch')`;
}

/** A new random id, made in the statement. */
export function randomId(db: Db): SQL {
  return isPostgres(db) ? sql`gen_random_uuid()::text` : sql`lower(hex(randomblob(16)))`;
}

/** Whether a text column holds `needle`, ignoring ASCII case: Postgres' LIKE minds it. */
export function containsText(db: Db, column: SQL | AnyColumn, needle: string): SQL {
  const pattern = `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return isPostgres(db)
    ? sql`${column} ILIKE ${pattern} ESCAPE '\\'`
    : sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}
