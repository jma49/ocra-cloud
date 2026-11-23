import { type Context, Hono } from "hono";
import { audit } from "../audit.js";
import { randomToken, sha256Hex } from "../crypto.js";
import type { Row } from "../db/scoped.js";
import { apiError } from "../http.js";
import type { CodePlatform } from "../platforms/platform.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import type { AutoReviewWebhookView } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { type HookTarget, provisionGitlabHook, removeGitlabHook } from "./gitlab-hook.js";

// A GitLab project's hook added for the account (docs/gitlab.md), with the
// project's own access token or GITLAB_BOT_TOKEN, which GitLab lets manage
// hooks from the Maintainer role. Without one, or below it, the hook is
// added by hand and reviews still arrive.

type Repo = Row<"reviewRepos">;

const GITLAB_HOOK = "/api/auto-review/webhooks/gitlab";

const gitlabHookUrl = (requestUrl: string) => new URL(GITLAB_HOOK, requestUrl).toString();

const PROBLEMS = {
  token: "no token may add the webhook: give the project an access token with the Maintainer role",
  role: "the token needs the Maintainer role to add the webhook",
  rejected: "GitLab refused the token: it is revoked or expired",
  unreachable: "GitLab did not answer",
} as const;

type Problem = keyof typeof PROBLEMS;

const byHand = (problem: Problem, url: string) =>
  `${PROBLEMS[problem]}; add it by hand: ${url}, with Merge request events, Comments and Pipeline events`;

async function targetFor(c: Context<AppEnv>, repo: Repo, platform: CodePlatform) {
  const bot = await c.var.bots?.forRepo(repo).catch(() => null);
  if (!bot) return null;
  return {
    instance: platform.url,
    projectId: repo.platformRepoId,
    token: bot.token,
  } satisfies HookTarget;
}

/**
 * Adds or updates the project's hook with `secret` and keeps its id, and
 * the secret's hash once GitLab took it; a problem when it could not.
 */
async function setUpGitlabHook(
  c: Context<AppEnv>,
  repo: Repo,
  platform: CodePlatform,
  secret: string,
): Promise<{ ok: true } | { ok: false; problem: Problem }> {
  const target = await targetFor(c, repo, platform);
  if (!target) return { ok: false, problem: "token" };
  const hook = await provisionGitlabHook(target, gitlabHookUrl(c.req.url), secret, repo.webhookId);
  if (!hook.ok) return { ok: false, problem: hook.reason };
  const kept = await c.var.data.update("reviewRepos", repo.id, {
    webhookId: hook.id,
    webhookSecretHash: await sha256Hex(secret),
  });
  if (kept) await audit(c.var.data, "auto_review.webhook_added", { repo: repo.fullName });
  return { ok: true };
}

/** What enrolling a GitLab project answers of its hook, after ocra tried to add it. */
export async function enrolledGitlabHook(
  c: Context<AppEnv>,
  repo: Repo,
  platform: CodePlatform,
  secret: string,
): Promise<AutoReviewWebhookView> {
  const url = gitlabHookUrl(c.req.url);
  const set = await setUpGitlabHook(c, repo, platform, secret);
  return set.ok
    ? { url, secret, managed: true }
    : { url, secret, managed: false, problem: byHand(set.problem, url) };
}

/** Removes the hook ocra added for a project no longer enrolled; recorded, never refused. */
export async function removeEnrolledHook(c: Context<AppEnv>, repo: Repo): Promise<void> {
  if (repo.platform !== "gitlab" || !repo.webhookId) return;
  const platform = platformsOf(c.env, c.req.url).find(
    (p) => p.kind === "gitlab" && p.host === repo.host,
  );
  const target = platform && (await targetFor(c, repo, platform));
  const removed = !!target && (await removeGitlabHook(target, repo.webhookId).catch(() => false));
  await audit(c.var.data, "auto_review.webhook_removed", { repo: repo.fullName, removed });
}

export function gitlabHookRoute() {
  const route = new Hono<AppEnv>();

  // A new secret each time: the one shown at enrolment is not kept.
  route.post("/repos/:id/webhook", requireSession(["web"]), perMinute("settings"), async (c) => {
    const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
    if (!repo) return apiError(c, "not_found");
    const url = gitlabHookUrl(c.req.url);
    const refuse = (message: string) =>
      apiError(c, "invalid_body", { issues: [{ path: ["webhook"], message }] });
    if (repo.platform !== "gitlab")
      return refuse("only a GitLab project's webhook is added by ocra");
    const platform = platformsOf(c.env, c.req.url).find(
      (p) => p.kind === "gitlab" && p.host === repo.host,
    );
    if (!platform) return apiError(c, "not_found");
    const secret = randomToken("ocra_hook_");
    const set = await setUpGitlabHook(c, repo, platform, secret);
    if (!set.ok) {
      return set.problem === "unreachable"
        ? apiError(c, "upstream_unreachable")
        : refuse(byHand(set.problem, url));
    }
    return c.json({ url, secret, managed: true } satisfies AutoReviewWebhookView);
  });

  return route;
}
