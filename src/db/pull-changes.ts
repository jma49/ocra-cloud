import { and, eq, isNull, lt, max, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { reviewRepos, reviews } from "./schema.js";

// When the pull requests an account sees last changed, as far as the
// server hears of it without asking a platform: a webhook about a pull
// request of one of its enrolled repositories, or a review of its own
// arriving. The inbox compares it with the one its listing carried, and
// reads the platforms again only when it moved.

type ReviewRepo = typeof reviewRepos.$inferSelect;

/**
 * Moves the enrolled repository's change time forward to `at`, never back;
 * the account and repository it moved, to tell the account's open consoles.
 */
export async function touchPulls(
  db: Db,
  platform: ReviewRepo["platform"],
  host: string,
  platformRepoId: string,
  at: Date,
): Promise<{ accountId: string; repoId: string }[]> {
  const t = reviewRepos;
  return await db
    .update(t)
    .set({ pullsChangedAt: at })
    .where(
      and(
        eq(t.platform, platform),
        eq(t.host, host),
        eq(t.platformRepoId, platformRepoId),
        or(isNull(t.pullsChangedAt), lt(t.pullsChangedAt, at)),
      ),
    )
    .returning({ accountId: t.accountId, repoId: t.id });
}

/** The newest of the account's repositories' change times and its reviews; null before any. */
export async function pullsChangedAt(db: Db, accountId: string): Promise<Date | null> {
  const [repos, own] = await db.batch([
    db
      .select({ at: max(reviewRepos.pullsChangedAt) })
      .from(reviewRepos)
      .where(eq(reviewRepos.accountId, accountId)),
    db
      .select({ at: max(reviews.createdAt) })
      .from(reviews)
      .where(eq(reviews.accountId, accountId)),
  ]);
  const times = [repos[0]?.at, own[0]?.at].flatMap((d) => (d ? [d.getTime()] : []));
  return times.length > 0 ? new Date(Math.max(...times)) : null;
}
