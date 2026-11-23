import { type Context, Hono } from "hono";
import { z } from "zod";
import type { ReviewJobSummary } from "../db/review-jobs.js";
import { apiError, jsonBody } from "../http.js";
import { COMMIT_ID } from "../platforms/contents.js";
import { byKind, pullRef, reach } from "../pull-page.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import { type PullReviewJobView, type PullReviewNowView, REVIEW_DEPTHS } from "../shared/index.js";
import type { AppEnv } from "../types.js";

// "Review now" on a pull request's page: a review of its current head by
// the server's runner (ADR-0046), for a repository the account enrolled.
// The person asked for it, so the account's skip_review rules do not apply.

export const reviewNow = new Hono<AppEnv>();

const pullQuery = z.object(pullRef);
const requestBody = z.object({
  ...pullRef,
  force: z.boolean().default(false),
  // This review only; the repository's depth otherwise.
  depth: z.enum(REVIEW_DEPTHS).nullable().default(null),
});
type Pull = z.output<typeof pullQuery>;

const jobView = (job: ReviewJobSummary): PullReviewJobView => ({
  // A superseded job is never answered: the queries leave it out.
  state: job.state === "superseded" ? "failed" : job.state,
  jobId: job.id,
  head: job.head,
  queuedAt: job.createdAt.toISOString(),
  depth: job.depth,
});

/** The account's enrolled repository the user reaches the pull request in, or the refusal. */
async function enrolledPull(c: Context<AppEnv>, pull: Pull) {
  if (!c.var.autoReview) return { refusal: apiError(c, "not_found") } as const;
  const reached = await reach(c, byKind(pull));
  if ("refusal" in reached) return { refusal: reached.refusal } as const;
  const { platform, token } = reached;
  const repo = await platform.contents.head(token, pull.repo);
  const enrolled =
    repo &&
    (await c.var.data.findOne("reviewRepos", {
      platform: platform.kind,
      host: platform.host,
      platformRepoId: repo.platformRepoId,
    }));
  if (!repo || !enrolled) return { refusal: apiError(c, "not_found") } as const;
  return { platform, token, repo, enrolled, service: c.var.autoReview } as const;
}

reviewNow.get("/review-now", requireSession(["web"]), perMinute("platform"), async (c) => {
  const pull = pullQuery.safeParse(c.req.query());
  if (!pull.success) return apiError(c, "not_found");
  const found = await enrolledPull(c, pull.data);
  if ("refusal" in found) return found.refusal;
  const job = await c.var.data.autoReview.latestPullJob(found.enrolled.id, pull.data.number);
  return c.json({
    job: job ? jobView(job) : null,
    depth: found.enrolled.reviewDepth,
  } satisfies PullReviewNowView);
});

reviewNow.post(
  "/review-now",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(requestBody),
  async (c) => {
    const body = c.req.valid("json");
    const found = await enrolledPull(c, body);
    if ("refusal" in found) return found.refusal;
    // The head is the platform's, read as the user: reading it proves they reach the pull request.
    const facts = await found.platform.mergeStatus.facts(
      found.token,
      found.repo.fullName,
      body.number,
    );
    if (!facts || !COMMIT_ID.test(facts.head)) return apiError(c, "not_found");
    const job = await c.var.data.autoReview.request(
      found.enrolled.id,
      body.number,
      facts.head,
      body.force,
      body.depth,
      new Date(),
    );
    if (!job) return apiError(c, "not_found");
    if (job.state === "queued") found.service.kick();
    return c.json({
      job: jobView(job),
      depth: found.enrolled.reviewDepth,
    } satisfies PullReviewNowView);
  },
);
