import { z } from "zod";
import type { Db } from "../db/client.js";
import type { FlowEvent } from "../db/pull-flows.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { type Row, scoped } from "../db/scoped.js";
import type { ReviewedPull } from "./paths.js";

// How an enrolled repository's pull request moves toward review, as its
// platform's webhooks say, for the review flow on Insights (src/flow.ts):
// opened, out of draft, reviewers asked, reviewed and approved. A time the
// platform wrote is taken where there is one; otherwise the delivery's.
// Reviews by the author or by a bot (the ocra bot's own included) are not
// reviews here. A kept review names its pull request, whose changed
// directories the caller reads after the answer (./paths.ts).

type Repo = Row<"reviewRepos">;

function timeOf(text: string | null | undefined): Date | null {
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const githubUser = z.object({
  login: z.string(),
  id: z.number().optional(),
  type: z.string().optional(),
});

const githubPullFields = z.object({
  title: z.string().max(1024),
  draft: z.boolean().optional(),
  user: githubUser.optional(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
});

const githubPullEvent = z.object({
  action: z.string(),
  number: z.number().int().min(1),
  pull_request: githubPullFields,
  repository: z.object({ id: z.number() }),
});

const githubReviewEvent = z.object({
  action: z.literal("submitted"),
  review: z.object({
    id: z.number(),
    user: githubUser.nullable(),
    state: z.string(),
    submitted_at: z.string().nullish(),
  }),
  pull_request: githubPullFields.extend({
    number: z.number().int().min(1),
    head: z.object({ sha: z.string() }).optional(),
  }),
  repository: z.object({ id: z.number() }),
});

const isBot = (u: z.infer<typeof githubUser>) => u.type === "Bot" || u.login.endsWith("[bot]");

function githubFlow(
  repo: Repo,
  number: number,
  pull: z.infer<typeof githubPullFields>,
  now: Date,
): FlowEvent {
  const size =
    pull.additions !== undefined && pull.deletions !== undefined
      ? pull.additions + pull.deletions
      : null;
  return {
    reviewRepoId: repo.id,
    number,
    title: pull.title,
    author: pull.user?.login ?? null,
    authorId: pull.user?.id !== undefined ? String(pull.user.id) : null,
    draft: pull.draft === true,
    size,
    openedAt: timeOf(pull.created_at),
    seenAt: now,
  };
}

/** A GitHub App webhook's pull request or review event (src/webhooks.ts verified it); the pull request a review was kept on. */
export async function recordGithubFlow(
  db: Db,
  host: string,
  event: string | undefined,
  body: unknown,
  now = new Date(),
): Promise<ReviewedPull | null> {
  if (event === "pull_request_review") return recordGithubReview(db, host, body, now);
  if (event !== "pull_request") return null;
  const parsed = githubPullEvent.safeParse(body);
  if (!parsed.success) return null;
  const { action, number, pull_request: pull, repository } = parsed.data;
  const repo = await reviewRepoFor(db, "github", host, String(repository.id));
  if (!repo) return null;
  const flow = githubFlow(repo, number, pull, now);
  const at = timeOf(pull.updated_at) ?? now;
  const opened = flow.openedAt ?? at;
  await scoped(db, repo.accountId).pullFlows.record({
    ...flow,
    ...(action === "opened" && !flow.draft ? { readyAt: opened } : {}),
    ...(action === "ready_for_review" ? { readyAt: at } : {}),
    ...(action === "reopened" ? { reopenedAt: at } : {}),
    ...(action === "review_requested" ? { firstReviewRequestedAt: at } : {}),
  });
  return null;
}

async function recordGithubReview(
  db: Db,
  host: string,
  body: unknown,
  now: Date,
): Promise<ReviewedPull | null> {
  const parsed = githubReviewEvent.safeParse(body);
  if (!parsed.success) return null;
  const { review, pull_request: pull, repository } = parsed.data;
  const repo = await reviewRepoFor(db, "github", host, String(repository.id));
  if (!repo) return null;
  const flow = githubFlow(repo, pull.number, pull, now);
  const data = scoped(db, repo.accountId).pullFlows;
  if (!review.user || isBot(review.user) || review.user.login === flow.author) {
    await data.record(flow);
    return null;
  }
  await data.review(flow, {
    reviewKey: `github:${review.id}`,
    reviewer: review.user.login,
    approved: review.state.toLowerCase() === "approved",
    submittedAt: timeOf(review.submitted_at) ?? now,
  });
  return { repo, number: pull.number, head: pull.head?.sha };
}

const gitlabUser = z.object({ id: z.number(), username: z.string() });

const gitlabEvent = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.string().optional(),
    title: z.string().max(1024),
    draft: z.boolean().optional(),
    author_id: z.number().optional(),
    created_at: z.string().nullish(),
    reviewer_ids: z.array(z.number()).optional(),
    last_commit: z.object({ id: z.string() }).optional(),
  }),
  user: gitlabUser.optional(),
  changes: z
    .object({
      draft: z
        .object({ previous: z.boolean().nullish(), current: z.boolean().nullish() })
        .optional(),
      reviewers: z
        .object({
          previous: z.array(z.unknown()).nullish(),
          current: z.array(z.unknown()).nullish(),
        })
        .optional(),
    })
    .optional(),
});

const APPROVALS = new Set(["approved", "approval"]);

/** A GitLab merge request hook its repository's secret proved; the merge request an approval was kept on. */
export async function recordGitlabFlow(
  db: Db,
  repo: Repo,
  body: unknown,
  now = new Date(),
): Promise<ReviewedPull | null> {
  const parsed = gitlabEvent.safeParse(body);
  if (!parsed.success) return null;
  const { object_attributes: a, user, changes } = parsed.data;
  const draft = a.draft === true;
  const opened = timeOf(a.created_at);
  const asked =
    (changes?.reviewers?.current?.length ?? 0) > (changes?.reviewers?.previous?.length ?? 0) ||
    (a.action === "open" && (a.reviewer_ids?.length ?? 0) > 0);
  const flow: FlowEvent = {
    reviewRepoId: repo.id,
    number: a.iid,
    title: a.title,
    // Who caused the event is the author only when the merge request opens.
    author: a.action === "open" && user ? user.username : null,
    authorId: a.author_id !== undefined ? String(a.author_id) : null,
    draft,
    size: null,
    openedAt: opened,
    seenAt: now,
    ...(a.action === "open" && !draft ? { readyAt: opened ?? now } : {}),
    ...(changes?.draft?.previous === true && changes.draft.current === false
      ? { readyAt: now }
      : {}),
    ...(a.action === "reopen" ? { reopenedAt: now } : {}),
    ...(asked ? { firstReviewRequestedAt: now } : {}),
  };
  const data = scoped(db, repo.accountId).pullFlows;
  if (a.action && APPROVALS.has(a.action) && user && user.id !== a.author_id) {
    await data.review(flow, {
      reviewKey: `gitlab:${a.iid}:approval:${user.id}`,
      reviewer: user.username,
      approved: true,
      submittedAt: now,
    });
    return { repo, number: a.iid, head: a.last_commit?.id };
  }
  await data.record(flow);
  return null;
}
