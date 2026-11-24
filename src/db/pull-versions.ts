import { and, asc, eq } from "drizzle-orm";
import { changedRows, type Db } from "./client.js";
import { pullVersions } from "./schema.js";

// The heads an enrolled repository's pull request was pushed to, as its
// webhooks said (src/pull-versions/hooks.ts). A head pushed again keeps its
// first push: the unique index decides, not a read before the write.

/** Heads kept per pull request; the oldest past this are not read. */
const MAX_KEPT_VERSIONS = 200;

const t = pullVersions;

export type KeptVersion = { head: string; pushedAt: Date; opened: boolean };

export function accountPullVersions(db: Db, accountId: string) {
  return {
    /** Keeps a head the pull request was pushed to; false when it was already kept. */
    async record(reviewRepoId: string, number: number, pushed: KeptVersion) {
      const added = await db
        .insert(t)
        .values({ id: crypto.randomUUID(), accountId, reviewRepoId, number, ...pushed })
        .onConflictDoNothing({ target: [t.reviewRepoId, t.number, t.head] });
      return changedRows(added) > 0;
    },

    /** The pull request's kept heads, first pushed first. */
    async of(reviewRepoId: string, number: number): Promise<KeptVersion[]> {
      return db
        .select({ head: t.head, pushedAt: t.pushedAt, opened: t.opened })
        .from(t)
        .where(
          and(eq(t.accountId, accountId), eq(t.reviewRepoId, reviewRepoId), eq(t.number, number)),
        )
        .orderBy(asc(t.pushedAt), asc(t.head))
        .limit(MAX_KEPT_VERSIONS);
    },
  };
}
