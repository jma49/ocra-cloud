import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { randomToken, sha256Hex } from "../crypto.js";
import type { ReviewJobSummary } from "../db/review-jobs.js";
import { recentRunners } from "../db/review-runners.js";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { accessToken } from "../platforms/links.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import {
  type AutoReviewEnrolledView,
  type AutoReviewLearnView,
  type AutoReviewRepoView,
  type AutoReviewSwitchView,
  CODE_PLATFORMS,
  LEARN_MODES,
  REVIEW_PROFILES,
  type ReviewProfileView,
  type ReviewRunnersView,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { enrollRepo, MAX_REVIEW_REPOS } from "./enroll.js";
import { enrollRoute } from "./enroll-routes.js";
import { generateRoute } from "./generate.js";
import { groupRoute } from "./group-routes.js";
import { enrolledGitlabHook, gitlabHookRoute, removeEnrolledHook } from "./hook-routes.js";
import { pullCommandRoute } from "./pull-command-routes.js";
import { repoTokenRoute } from "./repo-token-routes.js";
import { autoReviewWebhooks } from "./webhooks.js";

/** What a host that runs reviews itself gives the API (ADR-0046). */
export type AutoReviewService = {
  /** Wakes the review runner after a job is queued. */
  kick: () => void;
  /** Whether jobs wait for a remote runner to ask for them (./runner-api.ts). */
  remote?: true;
  /** Evaluates a pull request's pre-merge checks and posts them as the bot, after the answer. */
  checkPull?: (accountId: string, reviewRepoId: string, number: number) => void;
  /** The GitHub App the checks are posted as, whose re-runs of them are taken (src/merge-checks/rerun.ts). */
  githubAppId?: string;
};

const enrollSchema = z.object({
  platform: z.enum(CODE_PLATFORMS),
  // owner/repo on GitHub, group/subgroup/project on GitLab.
  fullName: z
    .string()
    .max(400)
    .regex(/^[\w.-]+(?:\/[\w.-]+)+$/, "a repository path")
    .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), "a repository path"),
  // Off unless asked for: every pull request reviewed is the account's spend.
  automatic: z.boolean().default(false),
});

const profileBody = z.object({ profile: z.enum(REVIEW_PROFILES) });
const automaticBody = z.object({ automatic: z.boolean() });
const learnBody = z.object({ learn: z.enum(LEARN_MODES) });

const repoView = (r: Row<"reviewRepos">, latest: ReviewJobSummary | undefined) =>
  ({
    id: r.id,
    platform: r.platform,
    host: r.host,
    fullName: r.fullName,
    profile: r.reviewProfile,
    automatic: r.automatic,
    learn: r.learn,
    hasAccessToken: !!r.accessTokenCiphertext,
    accessTokenBot: r.accessTokenCiphertext ? r.accessTokenBot : null,
    webhookManaged: r.webhookId !== null,
    paused: r.paused,
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
  route.route("/", repoTokenRoute());
  route.route("/", pullCommandRoute());
  route.route("/", gitlabHookRoute());
  route.route("/", enrollRoute(repoView));
  route.route("/", groupRoute());

  route.get("/repos", requireSession(), async (c) => {
    const [repos, latest] = await Promise.all([
      c.var.data.find("reviewRepos", {}, MAX_REVIEW_REPOS),
      c.var.data.autoReview.latestJobs(),
    ]);
    const byRepo = new Map(latest.map((j) => [j.reviewRepoId, j]));
    return c.json({ repos: repos.map((r) => repoView(r, byRepo.get(r.id))) });
  });

  route.get("/runners", requireSession(), async (c) => {
    const runners = service.remote ? await recentRunners(c.var.db, new Date()) : [];
    return c.json({
      remote: service.remote === true,
      runners: runners.map((r) => ({
        name: r.name,
        version: r.version,
        lastSeenAt: r.lastSeenAt.toISOString(),
      })),
    } satisfies ReviewRunnersView);
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
      // GitLab's project hook proves itself with a secret of its own;
      // GitHub's with the App's signature.
      const secret = platform.kind === "gitlab" ? randomToken("ocra_hook_") : undefined;
      const enrolled = await enrollRepo(c.var.data, platform, token, body.fullName, {
        automatic: body.automatic,
        webhookSecretHash: secret ? await sha256Hex(secret) : null,
      });
      if (enrolled.outcome === "refused") {
        if (enrolled.reason === "not_found") return apiError(c, "not_found");
        return apiError(c, "invalid_body", {
          issues: [
            {
              path: ["fullName"],
              message: `another account reviews this repository, or this one has ${MAX_REVIEW_REPOS}`,
            },
          ],
        });
      }
      const repo = enrolled.repo;
      const webhook = secret
        ? await enrolledGitlabHook(c, repo, platform, secret)
        : { url: new URL("/api/webhooks/github", c.req.url).toString() };
      const kept = (await c.var.data.get("reviewRepos", repo.id)) ?? repo;
      return c.json({
        repo: repoView(kept, undefined),
        webhook,
      } satisfies AutoReviewEnrolledView);
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

  route.put(
    "/repos/:id/automatic",
    requireSession(["web"]),
    perMinute("settings"),
    jsonBody(automaticBody),
    async (c) => {
      const { automatic } = c.req.valid("json");
      const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
      const changed = repo && (await c.var.data.update("reviewRepos", repo.id, { automatic }));
      if (!repo || !changed) return apiError(c, "not_found");
      await audit(c.var.data, "auto_review.automatic_changed", { repo: repo.fullName, automatic });
      return c.json({ automatic } satisfies AutoReviewSwitchView);
    },
  );

  route.put(
    "/repos/:id/learn",
    requireSession(["web"]),
    perMinute("settings"),
    jsonBody(learnBody),
    async (c) => {
      const { learn } = c.req.valid("json");
      const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
      const changed = repo && (await c.var.data.update("reviewRepos", repo.id, { learn }));
      if (!repo || !changed) return apiError(c, "not_found");
      await audit(c.var.data, "auto_review.learn_changed", { repo: repo.fullName, learn });
      return c.json({ learn } satisfies AutoReviewLearnView);
    },
  );

  route.delete("/repos/:id", requireSession(["web"]), async (c) => {
    const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
    const removed = repo !== undefined && (await c.var.data.remove("reviewRepos", repo.id));
    if (repo && removed) {
      await audit(c.var.data, "auto_review.unenrolled", { repo: repo.fullName });
      await removeEnrolledHook(c, repo);
    }
    return c.json({ removed });
  });

  return route;
}
