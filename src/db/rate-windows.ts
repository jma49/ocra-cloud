import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { rateWindows } from "./schema.js";

/**
 * Counts one call against `key`'s window of `periodMs`, starting a new
 * window when the last one is over, in one statement so that processes
 * sharing the database count together. The calls counted in the window,
 * this one included.
 */
export async function countInWindow(db: Db, key: string, periodMs: number, now = Date.now()) {
  const over = sql`${rateWindows.start} <= ${now - periodMs}`;
  const [row] = await db
    .insert(rateWindows)
    .values({ key, start: now, n: 1 })
    .onConflictDoUpdate({
      target: rateWindows.key,
      set: {
        n: sql`CASE WHEN ${over} THEN 1 ELSE ${rateWindows.n} + 1 END`,
        start: sql`CASE WHEN ${over} THEN ${now} ELSE ${rateWindows.start} END`,
      },
    })
    .returning({ n: rateWindows.n });
  return row?.n ?? 1;
}
