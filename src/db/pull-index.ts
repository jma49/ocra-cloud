import { and, desc, eq, gte, inArray, isNull, lt, lte, or, type SQL } from "drizzle-orm";
import type { CodePlatformKind } from "../shared/index.js";
import { changedRows, type Db } from "./client.js";
import { jsonHoldsText } from "./dialect.js";
import { platformLinks, pullIndex, reviewRepos } from "./schema.js";

// The inbox's index of the account's enrolled repositories' pull requests
// (src/pull-index/), and when a live listing last vouched for it. A write
// replaces the row it read only while its revision still holds, so two
// sources never interleave; which values win is ../pull-index/facts.ts's.

export type IndexRow = typeof pullIndex.$inferSelect;
export type IndexValues = Omit<IndexRow, "id" | "accountId" | "revision" | "createdAt">;
export type IndexState = { verifiedAt: Date | null; staleAt: Date | null };
export type IndexedRepo = {
  id: string;
  fullName: string;
  paused: string | null;
  pullsIndexedAt: Date | null;
};

const MAX_TITLE = 256;
/** Pull requests per statement, within D1's hundred bound parameters. */
const PER_STATEMENT = 40;

export function accountPullIndex(db: Db, accountId: string) {
  const t = pullIndex;
  const own = eq(t.accountId, accountId);
  const link = (platform: CodePlatformKind, host: string) =>
    and(
      eq(platformLinks.accountId, accountId),
      eq(platformLinks.platform, platform),
      eq(platformLinks.host, host),
    );
  const clip = (v: IndexValues): IndexValues => ({
    ...v,
    title: [...v.title].slice(0, MAX_TITLE).join(""),
  });

  return {
    async of(reviewRepoId: string, number: number): Promise<IndexRow | undefined> {
      const [row] = await db
        .select()
        .from(t)
        .where(and(own, eq(t.reviewRepoId, reviewRepoId), eq(t.number, number)))
        .limit(1);
      return row;
    },

    /** Writes values over the row read, or as a new row when none was; false when another write came first. */
    async write(read: IndexRow | undefined, values: IndexValues): Promise<boolean> {
      if (!read) {
        const added = await db
          .insert(t)
          .values({ ...clip(values), id: crypto.randomUUID(), accountId })
          .onConflictDoNothing({ target: [t.reviewRepoId, t.number] });
        return changedRows(added) > 0;
      }
      const changed = await db
        .update(t)
        .set({ ...clip(values), revision: read.revision + 1 })
        .where(and(own, eq(t.id, read.id), eq(t.revision, read.revision)));
      return changedRows(changed) > 0;
    },

    /**
     * The user's pull requests in the account's repositories on the
     * platform: open ones they wrote, are asked to review or are assigned,
     * and those they wrote that merged since (by when they merged, or last
     * changed); newest change first.
     */
    async mine(
      platform: CodePlatformKind,
      host: string,
      userId: string,
      since: Date,
      mergedBy: "mergedAt" | "changedAt",
      limit: number,
    ): Promise<IndexRow[]> {
      const r = reviewRepos;
      const repos = db
        .select({ id: r.id })
        .from(r)
        .where(and(eq(r.accountId, accountId), eq(r.platform, platform), eq(r.host, host)));
      return db
        .select()
        .from(t)
        .where(
          and(
            own,
            inArray(t.reviewRepoId, repos),
            or(
              and(
                eq(t.state, "open"),
                or(
                  eq(t.authorId, userId),
                  jsonHoldsText(db, t.reviewerIds, userId),
                  jsonHoldsText(db, t.assigneeIds, userId),
                ),
              ),
              and(eq(t.state, "merged"), eq(t.authorId, userId), gte(t[mergedBy], since)),
            ),
          ),
        )
        .orderBy(desc(t.changedAt))
        .limit(limit);
    },

    /** The rows of these pull requests, those the index holds. */
    async byNumbers(pulls: readonly { reviewRepoId: string; number: number }[]) {
      const found: IndexRow[] = [];
      for (let i = 0; i < pulls.length; i += PER_STATEMENT) {
        const each: SQL[] = pulls
          .slice(i, i + PER_STATEMENT)
          .flatMap((p) => and(eq(t.reviewRepoId, p.reviewRepoId), eq(t.number, p.number)) ?? []);
        found.push(
          ...(await db
            .select()
            .from(t)
            .where(and(own, or(...each)))),
        );
      }
      return found;
    },

    /** Whether an open row of the repository has this head commit. */
    async holdsHead(reviewRepoId: string, head: string): Promise<boolean> {
      const [row] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(own, eq(t.reviewRepoId, reviewRepoId), eq(t.state, "open"), eq(t.head, head)))
        .limit(1);
      return row !== undefined;
    },

    /** The repository's pull request merged from this head branch at or after `since`, the latest. */
    async mergedFrom(
      reviewRepoId: string,
      headBranch: string,
      since: Date,
    ): Promise<IndexRow | undefined> {
      const [row] = await db
        .select()
        .from(t)
        .where(
          and(
            own,
            eq(t.reviewRepoId, reviewRepoId),
            eq(t.state, "merged"),
            eq(t.headBranch, headBranch),
            gte(t.mergedAt, since),
          ),
        )
        .orderBy(desc(t.mergedAt))
        .limit(1);
      return row;
    },

    /** The numbers of the repository's rows still open. */
    async openNumbers(reviewRepoId: string): Promise<number[]> {
      const rows = await db
        .select({ number: t.number })
        .from(t)
        .where(and(own, eq(t.reviewRepoId, reviewRepoId), eq(t.state, "open")));
      return rows.map((r) => r.number);
    },

    /** Marks these open rows of the repository closed, unless they changed after `at`; how many. */
    async close(reviewRepoId: string, numbers: readonly number[], at: Date): Promise<number> {
      let closed = 0;
      for (let i = 0; i < numbers.length; i += PER_STATEMENT) {
        const changed = await db
          .update(t)
          .set({ state: "closed", closedAt: at, changedAt: at })
          .where(
            and(
              own,
              eq(t.reviewRepoId, reviewRepoId),
              eq(t.state, "open"),
              lte(t.changedAt, at),
              inArray(t.number, numbers.slice(i, i + PER_STATEMENT)),
            ),
          );
        closed += changedRows(changed);
      }
      return closed;
    },

    /** The account's enrolled repositories on the platform, with when each was last read in full. */
    repos(platform: CodePlatformKind, host: string): Promise<IndexedRepo[]> {
      const r = reviewRepos;
      return db
        .select({
          id: r.id,
          fullName: r.fullName,
          paused: r.paused,
          pullsIndexedAt: r.pullsIndexedAt,
        })
        .from(r)
        .where(and(eq(r.accountId, accountId), eq(r.platform, platform), eq(r.host, host)));
    },

    /** The reconciliation read all the repository's open pull requests at `at`. */
    async indexed(reviewRepoId: string, at: Date): Promise<void> {
      const r = reviewRepos;
      await db
        .update(r)
        .set({ pullsIndexedAt: at })
        .where(and(eq(r.accountId, accountId), eq(r.id, reviewRepoId)));
    },

    async state(platform: CodePlatformKind, host: string): Promise<IndexState | null> {
      const [row] = await db
        .select({ verifiedAt: platformLinks.pullsVerifiedAt, staleAt: platformLinks.pullsStaleAt })
        .from(platformLinks)
        .where(link(platform, host))
        .limit(1);
      return row ?? null;
    },

    /** A live listing read from `at` on matched the index; never moves back. */
    async verified(platform: CodePlatformKind, host: string, at: Date): Promise<void> {
      const l = platformLinks;
      await db
        .update(l)
        .set({ pullsVerifiedAt: at })
        .where(and(link(platform, host), or(isNull(l.pullsVerifiedAt), lt(l.pullsVerifiedAt, at))));
    },

    /** Something the index cannot hold changed at `at`; never moves back. */
    async stale(platform: CodePlatformKind, host: string, at: Date): Promise<void> {
      const l = platformLinks;
      await db
        .update(l)
        .set({ pullsStaleAt: at })
        .where(and(link(platform, host), or(isNull(l.pullsStaleAt), lt(l.pullsStaleAt, at))));
    },
  };
}
