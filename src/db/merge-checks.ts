import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { MergeCheckResultView, MergeChecksConclusion } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { mergeCheckRuns, mergeChecks, reviewRepos } from "./schema.js";

// An enrolled repository's pre-merge checks and how each head fared
// (reached through scoped()). A check is added under the repository's cap
// in one statement; a head's result is posted by the one caller whose
// compare-and-set moved its posted digest.

type NewCheck = Pick<typeof mergeChecks.$inferInsert, "kind" | "mode" | "settings">;

export type CheckRunRecord = {
  reviewRepoId: string;
  number: number;
  head: string;
  conclusion: MergeChecksConclusion;
  results: MergeCheckResultView[];
  digest: string;
};

export function accountMergeChecks(db: Db, accountId: string) {
  const t = mergeChecks;
  const r = mergeCheckRuns;
  return {
    enrolledRepo: (platform: "github" | "gitlab", host: string, fullName: string) =>
      enrolledRepoNamed(db, accountId, platform, host, fullName),

    /**
     * Adds the check to one of the account's enrolled repositories unless it
     * has cap already; returns its id, or undefined.
     */
    async add(reviewRepoId: string, check: NewCheck, cap: number): Promise<string | undefined> {
      const id = crypto.randomUUID();
      const inserted = await db.insert(t).select(sql`
        SELECT ${id}, ${accountId}, ${reviewRepoId}, ${check.kind}, ${check.mode},
          ${JSON.stringify(check.settings)}, ${Date.now()}
        WHERE EXISTS (SELECT 1 FROM ${reviewRepos} WHERE id = ${reviewRepoId} AND account_id = ${accountId})
          AND (SELECT count(*) FROM ${t} WHERE review_repo_id = ${reviewRepoId}) < ${cap}`);
      return changedRows(inserted) > 0 ? id : undefined;
    },

    /** Stores the head's result, replacing an earlier one of the same head; its row's id. */
    async record(run: CheckRunRecord, now: Date): Promise<string | undefined> {
      const [row] = await db
        .insert(r)
        .values({ id: crypto.randomUUID(), accountId, ...run, createdAt: now })
        .onConflictDoUpdate({
          target: [r.reviewRepoId, r.number, r.head],
          set: {
            conclusion: sql`excluded.conclusion`,
            results: sql`excluded.results`,
            digest: sql`excluded.digest`,
          },
          setWhere: eq(r.accountId, accountId),
        })
        .returning({ id: r.id });
      return row?.id;
    },

    /** Takes the post of this digest: true for one caller, until it is released. */
    async claimPost(id: string, digest: string): Promise<boolean> {
      const claimed = await db
        .update(r)
        .set({ postedDigest: digest })
        .where(
          and(
            eq(r.accountId, accountId),
            eq(r.id, id),
            eq(r.digest, digest),
            or(isNull(r.postedDigest), ne(r.postedDigest, digest)),
          ),
        );
      return changedRows(claimed) > 0;
    },

    /** Gives the claim back after a post that failed, so the next evaluation posts it. */
    async releasePost(id: string, digest: string): Promise<void> {
      await db
        .update(r)
        .set({ postedDigest: null })
        .where(and(eq(r.accountId, accountId), eq(r.id, id), eq(r.postedDigest, digest)));
    },
  };
}

/** The account's enrolled repository by its path, whose case the CLI folds. */
function enrolledRepoNamed(
  db: Db,
  accountId: string,
  platform: (typeof reviewRepos.$inferSelect)["platform"],
  host: string,
  fullName: string,
): Promise<typeof reviewRepos.$inferSelect | undefined> {
  const t = reviewRepos;
  return db
    .select()
    .from(t)
    .where(
      and(
        eq(t.accountId, accountId),
        eq(t.platform, platform),
        eq(t.host, host),
        sql`lower(${t.fullName}) = ${fullName.toLowerCase()}`,
      ),
    )
    .limit(1)
    .then(first);
}
