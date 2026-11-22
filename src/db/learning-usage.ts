import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { jsonElements } from "./dialect.js";
import { reviews } from "./schema.js";

// How often a repository's reviews were given each learning, from the ids
// their uploads named, counted in SQL. Reached only through scoped().

export type LearningUsage = { id: string; reviews: number; lastUsedAt: Date };

/** Per learning id of ids: the repository's reviews since a time that named it, and the newest. */
export async function learningUsage(
  db: Db,
  accountId: string,
  repoHash: string,
  ids: readonly string[],
  since: Date,
): Promise<LearningUsage[]> {
  if (ids.length === 0) return [];
  const r = reviews;
  const id = sql<string>`je.value`;
  const rows = await db
    .select({
      id,
      // Qualified: json_each has an id column of its own.
      reviews: sql<number>`count(DISTINCT ${r}.id)`.as("reviews"),
      lastUsedAt: sql<number>`max(${r}.created_at)`.as("last_used_at"),
    })
    .from(sql`${r}, ${jsonElements(db, sql`${r.learnings}`)}`)
    .where(
      and(
        eq(r.accountId, accountId),
        eq(r.repoHash, repoHash),
        gte(r.createdAt, since),
        isNotNull(r.learnings),
        inArray(id, [...ids]),
      ),
    )
    .groupBy(id);
  return rows.map((u) => ({
    id: u.id,
    reviews: Number(u.reviews),
    lastUsedAt: new Date(Number(u.lastUsedAt)),
  }));
}
