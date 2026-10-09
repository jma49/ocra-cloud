import { env } from "cloudflare:workers";

/** Rows read and written, as D1 bills them (each index entry written is a row). */
export type Meter = { read: number; written: number };

/**
 * A D1 binding that adds up the rows its statements read and wrote, from
 * D1's own `meta`. raw(), which drizzle uses for selects, carries no meta:
 * a select also runs once as all() for it; any other statement runs only as
 * all(), its rows turned into arrays (they have no repeated column names).
 */
export function metered(): { DB: D1Database; meter: Meter } {
  const meter: Meter = { read: 0, written: 0 };
  const add = ({ meta }: D1Result) => {
    meter.read += meta.rows_read;
    meter.written += meta.rows_written;
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(s, p) {
        if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args), sql);
        if (p === "run" || p === "all")
          return async () => {
            const result = await s.all();
            add(result);
            return result;
          };
        if (p === "raw")
          return async () => {
            if (/^\s*select\b/i.test(sql)) {
              const rows = await s.raw();
              add(await s.all());
              return rows;
            }
            const result = await s.all();
            add(result);
            return result.results.map((row) => Object.values(row as object));
          };
        if (p === "first") throw new Error("first() is not metered");
        const value = Reflect.get(s, p);
        return typeof value === "function" ? value.bind(s) : value;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements.map((s) => real.get(s) ?? s));
          for (const r of results) add(r);
          return results;
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { DB, meter };
}
