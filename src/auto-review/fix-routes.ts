import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { pullOfReview, pullOnPlatform } from "../review-pull.js";
import { fixOf } from "../reviews.js";
import { requireSession } from "../session.js";
import {
  CODE_PLATFORMS,
  type FindingFixView,
  type FixJobView,
  type FixRequestView,
  MAX_DAILY_FIX_REQUESTS,
  type PullFixJobsView,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import type { AutoReviewService } from "./routes.js";

// "Fix with ocra" (./fix-work.ts): a fix asked of `ocra fix` in the runner
// for a finding of a review of a pull request in a repository the account
// enrolled, which came without one. Enrolling proved the account reaches the
// repository; the run reads the pull request with a read-only bot token.

const requestBody = z.object({ finding: z.string().min(1).max(100) });
const pullQuery = z.object({
  platform: z.enum(CODE_PLATFORMS),
  repo: z.string().min(1).max(400),
  number: z.coerce
    .number()
    .int()
    .min(1)
    .max(2 ** 31 - 1),
});

const jobView = (j: Row<"fixJobs">) =>
  ({
    id: j.id,
    finding: j.findingId,
    head: j.head,
    // Fixes are never superseded: a row in that state is one that failed.
    state: j.state === "superseded" ? "failed" : j.state,
    outcome: j.outcome,
    reason: j.reason,
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
  }) satisfies FixJobView;

/** The finding's review's pull request, and the enrolled repository it is in; undefined for any other. */
async function enrolledPull(c: Context<AppEnv>, finding: Row<"findings">) {
  const review = await c.var.data.get("reviews", finding.reviewId);
  const reviewed = review && pullOfReview(review);
  const on = reviewed && pullOnPlatform(platformsOf(c.env, c.req.url), reviewed);
  if (!on) return undefined;
  const repo = await c.var.data.findOne("reviewRepos", {
    platform: on.platform.kind,
    host: on.platform.host,
    fullName: on.pull.repo,
  });
  return repo && { repo, number: on.pull.number, head: on.pull.head };
}

export function fixRoute(service: AutoReviewService) {
  const route = new Hono<AppEnv>();

  route.post(
    "/",
    requireSession(["web"]),
    perMinute("platform"),
    jsonBody(requestBody),
    async (c) => {
      const data = c.var.data;
      const finding = await data.get("findings", c.req.valid("json").finding);
      if (!finding) return apiError(c, "not_found");
      const answer = (outcome: FixRequestView["outcome"], job: Row<"fixJobs"> | undefined) =>
        c.json({ outcome, job: job ? jobView(job) : null } satisfies FixRequestView);
      if (fixOf(finding)) return answer("has_fix", undefined);
      if (finding.status !== "open") return answer("not_open", undefined);
      const pull = await enrolledPull(c, finding);
      if (!pull) return apiError(c, "not_found");
      const job = { reviewRepoId: pull.repo.id, number: pull.number, head: pull.head };
      const queued = await data.fixes.request(
        { ...job, findingId: finding.id },
        MAX_DAILY_FIX_REQUESTS,
        new Date(),
      );
      if (queued === "limited") {
        // A request already made is answered past the limit too: it costs nothing more.
        const made = await data.fixes.forFinding(finding.id, pull.head);
        if (made && made.state !== "failed") return answer("requested", made);
        return apiError(c, "daily_limit", { limit: MAX_DAILY_FIX_REQUESTS });
      }
      if (queued) {
        await audit(data, "pull.fix_requested", {
          pull: `${pull.repo.fullName}#${pull.number}`,
          finding: finding.id,
        });
        service.kick();
      }
      return answer(
        queued ? "queued" : "requested",
        await data.fixes.forFinding(finding.id, pull.head),
      );
    },
  );

  route.get("/finding/:id", requireSession(["web"]), async (c) => {
    const finding = await c.var.data.get("findings", c.req.param("id"));
    const review = finding && (await c.var.data.get("reviews", finding.reviewId));
    const head = review && pullOfReview(review)?.head;
    if (!finding || !review) return apiError(c, "not_found");
    const job = head ? await c.var.data.fixes.forFinding(finding.id, head) : undefined;
    return c.json({ job: job ? jobView(job) : null } satisfies FindingFixView);
  });

  route.get("/", requireSession(["web"]), async (c) => {
    const ref = pullQuery.safeParse(c.req.query());
    if (!ref.success) return apiError(c, "not_found");
    const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === ref.data.platform);
    const repo =
      platform &&
      (await c.var.data.findOne("reviewRepos", {
        platform: platform.kind,
        host: platform.host,
        fullName: ref.data.repo,
      }));
    if (!repo) return c.json({ enrolled: false, jobs: [] } satisfies PullFixJobsView);
    const jobs = await c.var.data.fixes.forPull(repo.id, ref.data.number);
    return c.json({ enrolled: true, jobs: jobs.map(jobView) } satisfies PullFixJobsView);
  });

  return route;
}
