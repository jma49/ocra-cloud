import type { Row, Scoped } from "./db/scoped.js";

// A head can be reviewed more than once (a re-review, another depth), and a
// later review does not report again what an earlier one already posted. A
// finding stays open until it is decided or seen fixed, so the pull request's
// open findings are those of every review of its head.

/** Reviews of one head looked through, newest first: far more than a head gets. */
const MAX_REVIEWS = 20;

/**
 * The newest review of the pull request at head, and the open findings of
 * all its reviews there. Where two reviews hold the same finding (by its
 * fingerprint) the newer one's word stands, whatever its status.
 */
export async function openAtHead(
  data: Scoped,
  pull: { prRepository: string; prNumber: number; prHeadSha: string },
): Promise<{ review: Row<"reviews"> | undefined; open: Row<"findings">[] }> {
  const reviews = await data.listNewest("reviews", MAX_REVIEWS, pull);
  const perReview = await Promise.all(reviews.map((r) => data.findingsOf(r.id)));
  const seen = new Set<string>();
  const open: Row<"findings">[] = [];
  for (const f of perReview.flat()) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    if (f.status === "open") open.push(f);
  }
  return { review: reviews[0], open };
}
