import type { CallBudget } from "./calls.js";
import type { ReconcileTurn } from "./db/reconcile.js";
import type { Ask } from "./db/review-requests.js";
import { TEAM_PREFIX, teamReviewerId } from "./db/review-teams.js";
import type { Scoped } from "./db/scoped.js";
import type { CodePlatform } from "./platforms/platform.js";
import type { ReconciledPull, ReconciledReview, Spent } from "./platforms/reconcile.js";

// The daily reconciliation's pass over an enrolled repository's open pull
// requests changed lately (src/reconcile.ts): their reviews, and whose
// review they ask now, as the platform has them, so a review, an ask or
// the end of one a webhook missed is filled in. A review is kept as its
// webhook keeps it (pull_reviews once per platform review, the asks it
// ends); an ask the platform shows and the server does not is started at
// the run's time, not before, so no reminder counts a wait the server
// never saw; one the server holds waiting that the platform no longer
// shows ends at the platform's last change. An ask and its end are written
// only as they were read (compare-and-set), and only when they are older
// than the platform's last change, so a webhook that arrived since stands,
// and a round ended here never tells of an ask before it again. A GitLab
// approval rule's group is not among a merge request's reviewers: its asks
// are left to its webhooks; an approval taken back leaves the reviewer
// waiting again, as the unapproval's webhook does.

/** Open pull requests read per repository, the most lately changed first: one call each. */
const REVIEW_PULLS = 10;
/** Asks on record read per pull request: far more than a pull request is asked of. */
const ASKS_CAP = 200;

type Pass = {
  data: Scoped;
  repo: ReconcileTurn;
  platform: CodePlatform;
  token: string;
  open: readonly ReconciledPull[];
  /** Pull requests last changed before are left out: an earlier day's run read them. */
  since: Date;
  calls: CallBudget;
  now: Date;
};

/** The reviews and asks of the open pull requests changed since, filled in; how many it wrote, or spent. */
export async function reconcileReviews(r: Pass): Promise<number | Spent> {
  const changed = r.open
    .flatMap((p) => (p.updatedAt && p.updatedAt >= r.since ? [{ p, at: p.updatedAt }] : []))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, REVIEW_PULLS);
  let written = 0;
  for (const { p, at } of changed) {
    const reviews = await r.platform.reconcile.reviews(r.token, r.repo.fullName, p.number, r.calls);
    // What it filled stands; the next run reads the repository again.
    if (reviews === "spent") return "spent";
    if (!reviews) continue;
    written += await fillReviews(r, p, at, reviews);
    written += await fillAsks(r, p, at, reviews);
  }
  return written;
}

async function fillReviews(
  r: Pass,
  p: ReconciledPull,
  at: Date,
  reviews: readonly ReconciledReview[],
): Promise<number> {
  const flow = {
    reviewRepoId: r.repo.id,
    number: p.number,
    title: p.title,
    author: p.author,
    authorId: p.authorId,
    draft: p.draft,
    size: null,
    openedAt: p.openedAt,
    seenAt: at,
  };
  let written = 0;
  for (const v of reviews) {
    if (v.bot || v.reviewerId === p.authorId) continue;
    const submittedAt = v.submittedAt ?? at;
    // A webhook keeps no review from before the repository was enrolled.
    if (submittedAt < r.repo.createdAt) continue;
    await r.data.pullFlows.review(flow, {
      reviewKey: v.reviewKey,
      reviewer: v.reviewer,
      approved: v.approved,
      submittedAt,
    });
    const done: Ask = {
      reviewRepoId: r.repo.id,
      number: p.number,
      reviewerId: v.reviewerId,
      reviewer: v.reviewer,
      at: submittedAt,
    };
    await r.data.reviewRequests.done(done);
    await r.data.reviewRequests.doneByMember({
      ...done,
      platform: r.platform.kind,
      host: r.platform.host,
    });
    written++;
  }
  return written;
}

async function fillAsks(
  r: Pass,
  p: ReconciledPull,
  at: Date,
  reviews: readonly ReconciledReview[],
): Promise<number> {
  // GitLab keeps an approver among the reviewers; its ask ended with the approval.
  const approved = new Set(
    r.platform.kind === "gitlab" ? reviews.filter((v) => v.approved).map((v) => v.reviewerId) : [],
  );
  const asked = new Map(
    p.asks
      .filter((a) => a.team || !approved.has(a.id))
      .map((a) => [a.team ? teamReviewerId(a.id) : a.id, a.name]),
  );
  const held = await r.data.reviewRequests.onPulls(r.repo.id, [p.number], ASKS_CAP);
  const of = (reviewerId: string, when: Date, reviewer?: string | null): Ask => ({
    reviewRepoId: r.repo.id,
    number: p.number,
    reviewerId,
    reviewer: reviewer ?? null,
    at: when,
  });
  let written = 0;
  for (const [reviewerId, reviewer] of asked) {
    const row = held.find((h) => h.reviewerId === reviewerId);
    if (!row) {
      await r.data.reviewRequests.askedOnce(of(reviewerId, r.now, reviewer));
      written++;
    } else if (row.doneAt && row.doneAt >= row.requestedAt && row.doneAt < at) {
      const again = new Date(Math.max(r.now.getTime(), row.doneAt.getTime() + 1));
      await r.data.reviewRequests.askedAgain(of(reviewerId, again, reviewer), {
        requestedAt: row.requestedAt,
        doneAt: row.doneAt,
      });
      written++;
    }
  }
  for (const row of held) {
    if (asked.has(row.reviewerId)) continue;
    if (row.doneAt && row.doneAt >= row.requestedAt) continue;
    if (r.platform.kind === "gitlab" && row.reviewerId.startsWith(TEAM_PREFIX)) continue;
    if (row.requestedAt > at) continue;
    await r.data.reviewRequests.endedSince(of(row.reviewerId, at), {
      requestedAt: row.requestedAt,
    });
    written++;
  }
  return written;
}
