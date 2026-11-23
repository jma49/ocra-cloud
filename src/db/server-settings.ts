import { inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "./client.js";
import { serverSettings } from "./schema.js";

// A self-hosted server's saved settings (src/node/setup/), as stored: a
// secret's value is still sealed here.

const t = serverSettings;

export type StoredSetting = { name: string; value: string; sealed: boolean };

export function storedSettings(db: Db): Promise<StoredSetting[]> {
  return db.select({ name: t.name, value: t.value, sealed: t.sealed }).from(t);
}

/** Writes each setting, replacing a saved one of its name, and removes those named in `removed`, at once. */
export async function storeSettings(
  db: Db,
  written: readonly StoredSetting[],
  removed: readonly string[],
  now: Date,
): Promise<void> {
  const work: BatchItem<"sqlite">[] = written.map((s) =>
    db
      .insert(t)
      .values({ ...s, updatedAt: now })
      .onConflictDoUpdate({
        target: t.name,
        set: { value: s.value, sealed: s.sealed, updatedAt: now },
      }),
  );
  if (removed.length > 0) work.push(db.delete(t).where(inArray(t.name, [...removed])));
  const [first, ...rest] = work;
  if (first) await db.batch([first, ...rest]);
}
