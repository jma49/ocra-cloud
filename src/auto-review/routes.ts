import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { randomToken, sha256Hex } from "../crypto.js";
import type { ReviewJobSummary } from "../db/review-jobs.js";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { accessToken } from "../platforms/links.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import {
  type AutoReviewRepoView,
  CODE_PLATFORMS,
  REVIEW_PROFILES,
  type ReviewProfileView,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { generateRoute } from "./generate.js";
import { autoReviewWebhooks } from "./webhooks.js";

/** What a host that runs reviews itself gives the API (ADR-0046). */
export type AutoReviewService = {
  /** Wakes the review runner after a job is queued. */
  kick: () => void;
  /** Evaluates a pull request's pre-merge checks and posts them as the bot, after the answer. */
  checkPull?: (accountId: string, reviewRepoId: string, number: number) => void;
};

const MAX_REVIEW_REPOS = 100;

const enrollSchema = z.object({
  platform: z.enum(CODE_PLATFORMS),
  // owner/repo on GitHub, group/subgroup/project on GitLab.
  fullName: z
    .string()
    .max(400)
    .regex(/^[\w.-]+(?:\/[\w.-]+)+$/, "a repository path")
    .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), "a repository path"),
});

const profileBody = z.object({ profile: z.enum(REVIEW_PROFILES) });

const repoView = (r: Row<"reviewRepos">, latest: ReviewJobSummary | undefined) =>
  ({
    id: r.id,
    platform: r.platform,
    host: r.host,
    fullName: r.fullName,
    profile: r.reviewProfile,
    latest: latest
      ? {
          number: latest.number,
          head: latest.head,
          state: latest.state,
          error: latest.error,
          finishedAt: latest.finishedAt?.toISOString() ?? null,
        }
      : null,
  }) satisfies AutoReviewRepoView;

export function autoReviewRoute(service: AutoReviewService) {
  const route = new Hono<AppEnv>();

  route.route("/webhooks", autoReviewWebhooks(service));
  route.route("/generate", generateRoute(service));

  route.get("/repos", requireSession(), async (c) => {
    const [repos, latest] = await Promise.all([
      c.var.data.find("reviewRepos", {}, MAX_REVIEW_REPOS),
      c.var.data.autoReview.latestJobs(),
    ]);
    const byRepo = new Map(latest.map((j) => [j.reviewRepoId, j]));
    return c.json({ repos: repos.map((r) => repoView(r, byRepo.get(r.id))) });
  });

  route.post(
    "/repos",
    requireSession(["web"]),
    perMinute("settings"),
    jsonBody(enrollSchema),
    async (c) => {
      const body = c.req.valid("json");
      const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === body.platform);
      if (!platform) return apiError(c, "not_found");
      const token = await accessToken(c.var.data, c.env, platform);
      if (!token) return apiError(c, "github_user");
      // Reading it as the user proves they reach it; the platform's id is what hooks name.
      const head = await platform.contents.head(token, body.fullName);
      if (!head) return apiError(c, "not_found");
      // GitLab's project hook proves itself with a secret of its own;
      // GitHub's with the App's signature.
      const secret = platform.kind === "gitlab" ? randomToken("ocra_hook_") : undefined;
      const id = await c.var.data.autoReview.enroll(
        {
          platform: platform.kind,
          host: platform.host,
          platformRepoId: head.platformRepoId,
          fullName: head.fullName,
          webhookSecretHash: secret ? await sha256Hex(secret) : null,
        },
        MAX_REVIEW_REPOS,
      );
      if (!id) {
        return apiError(c, "invalid_body", {
          issues: [
            {
              path: ["fullName"],
              message: `another account reviews this repository, or this one has ${MAX_REVIEW_REPOS}`,
            },
          ],
        });
      }
      const repo = await c.var.data.get("reviewRepos", id);
      if (!repo) return apiError(c, "not_found");
      await audit(c.var.data, "auto_review.enrolled", {
        repo: repo.fullName,
        platform: repo.platform,
      });
      const hook =
        platform.kind === "gitlab" ? "/api/auto-review/webhooks/gitlab" : "/api/webhooks/github";
      return c.json({
        repo: repoView(repo, undefined),
        webhook: { url: new URL(hook, c.req.url).toString(), ...(secret ? { secret } : {}) },
      });
    },
  );

  route.get("/repos/:id/profile", requireSession(), async (c) => {
    const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
    if (!repo) return apiError(c, "not_found");
    return c.json({ profile: repo.reviewProfile } satisfies ReviewProfileView);
  });

  route.put(
    "/repos/:id/profile",
    requireSession(["web"]),
    perMinute("settings"),
    jsonBody(profileBody),
    async (c) => {
      const { profile } = c.req.valid("json");
      const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
      const changed =
        repo &&
        (await c.var.data.update("reviewRepos", repo.id, {
          reviewProfile: profile,
        }));
      if (!repo || !changed) return apiError(c, "not_found");
      await audit(c.var.data, "auto_review.profile_changed", { repo: repo.fullName, profile });
      return c.json({ profile } satisfies ReviewProfileView);
    },
  );

  route.delete("/repos/:id", requireSession(["web"]), async (c) => {
    const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
    const removed = repo !== undefined && (await c.var.data.remove("reviewRepos", repo.id));
    if (repo && removed) await audit(c.var.data, "auto_review.unenrolled", { repo: repo.fullName });
    return c.json({ removed });
  });

  return route;
}
