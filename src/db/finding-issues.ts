import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { FindingIssueView } from "../shared/index.js";
import type { Db } from "./client.js";
import { findingIssues } from "./schema.js";

// The issues opened from the account's findings, one per finding: the
// creation is claimed in the database first, so two clicks open one issue.
// Reached only through scoped().

/** How long a creation in flight holds its claim before another may take it over. */
export const ISSUE_CLAIM_MS = 60_000;

/** The claim's time, to finish or release it with; the issue already opened; or a creation in flight. */
export type IssueClaim = { claimed: Date } | { issue: FindingIssueView } | { pending: true };

type Finding = { id: string; reviewId: string };

export function accountFindingIssues(db: Db, accountId: string) {
  const t = findingIssues;
  const ofFinding = (findingId: string) =>
    and(eq(t.accountId, accountId), eq(t.findingId, findingId));
  const opened = (row: { number: number | null; url: string | null } | undefined) =>
    row && row.number !== null && row.url !== null ? { number: row.number, url: row.url } : null;
  return {
    /** The issues opened from a review's findings, by finding id. */
    async ofReview(reviewId: string): Promise<Map<string, FindingIssueView>> {
      const rows = await db
        .select({ findingId: t.findingId, number: t.number, url: t.url })
        .from(t)
        .where(and(eq(t.accountId, accountId), eq(t.reviewId, reviewId), isNotNull(t.number)));
      return new Map(
        rows.flatMap((r) => {
          const issue = opened(r);
          return issue ? [[r.findingId, issue] as const] : [];
        }),
      );
    },

    async of(findingId: string): Promise<FindingIssueView | null> {
      const [row] = await db
        .select({ number: t.number, url: t.url })
        .from(t)
        .where(ofFinding(findingId));
      return opened(row);
    },

    /** Claims the finding's issue for one caller; a claim older than ISSUE_CLAIM_MS is taken over. */
    async claim(finding: Finding, now: Date): Promise<IssueClaim> {
      const lapsed = new Date(now.getTime() - ISSUE_CLAIM_MS);
      const taken = await db
        .insert(t)
        .values({
          id: crypto.randomUUID(),
          accountId,
          findingId: finding.id,
          reviewId: finding.reviewId,
          claimedAt: now,
        })
        .onConflictDoUpdate({
          target: [t.findingId, t.accountId, t.reviewId],
          set: { claimedAt: now },
          // The conflict is on a key with the account in it: the row is its own.
          setWhere: sql`${t.number} IS NULL AND ${t.claimedAt} < ${lapsed.getTime()}`,
        })
        .returning({ id: t.id });
      if (taken.length > 0) return { claimed: now };
      const issue = await this.of(finding.id);
      return issue ? { issue } : { pending: true };
    },

    /** Records the issue the claim opened; false when the claim was taken over meanwhile. */
    async record(findingId: string, claimed: Date, issue: FindingIssueView): Promise<boolean> {
      const done = await db
        .update(t)
        .set({ number: issue.number, url: issue.url })
        .where(and(ofFinding(findingId), isNull(t.number), eq(t.claimedAt, claimed)))
        .returning({ id: t.id });
      return done.length > 0;
    },

    /** Gives the claim up when nothing was opened, so the next click tries again. */
    async release(findingId: string, claimed: Date): Promise<void> {
      await db
        .delete(t)
        .where(and(ofFinding(findingId), isNull(t.number), eq(t.claimedAt, claimed)));
    },
  };
}
