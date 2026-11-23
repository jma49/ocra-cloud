import { type Context, Hono } from "hono";
import { audit } from "../audit.js";
import { randomToken, sha256Hex } from "../crypto.js";
import type { Row } from "../db/scoped.js";
import { apiError } from "../http.js";
import type { CodePlatform } from "../platforms/platform.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import type { AutoReviewWebhookSecretView, AutoReviewWebhookView } from "../shared/index.js";
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

/** The events of GitLab's Settings → Webhooks that ./webhooks.ts reads, as GitLab names them. */
const HAND_EVENTS = ["Merge request events", "Comments", "Pipeline events"];

const byHand = (problem: Problem, url: string) =>
  `${PROBLEMS[problem]}; add it by hand: ${url}, with ${HAND_EVENTS.slice(0, -1).join(", ")} and ${HAND_EVENTS.at(-1)}`;

const secretRoute = (id: string) => `/api/auto-review/repos/${id}/webhook/secret`;

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

const refuse = (c: Context<AppEnv>, message: string) =>
  apiError(c, "invalid_body", { issues: [{ path: ["webhook"], message }] });

export function gitlabHookRoute() {
  const route = new Hono<AppEnv>();

  /** The account's enrolled GitLab project and its instance, or the refusal. */
  async function gitlabRepo(c: Context<AppEnv>, only: string) {
    const repo = await c.var.data.get("reviewRepos", c.req.param("id") ?? "");
    if (!repo) return { refused: apiError(c, "not_found") };
    if (repo.platform !== "gitlab") return { refused: refuse(c, only) };
    const platform = platformsOf(c.env, c.req.url).find(
      (p) => p.kind === "gitlab" && p.host === repo.host,
    );
    if (!platform) return { refused: apiError(c, "not_found") };
    return { repo, platform };
  }

  // A new secret each time: the one shown at enrolment is not kept.
  route.post("/repos/:id/webhook", requireSession(["web"]), perMinute("settings"), async (c) => {
    const found = await gitlabRepo(c, "only a GitLab project's webhook is added by ocra");
    if ("refused" in found) return found.refused;
    const { repo, platform } = found;
    const url = gitlabHookUrl(c.req.url);
    const secret = randomToken("ocra_hook_");
    const set = await setUpGitlabHook(c, repo, platform, secret);
    if (!set.ok) {
      return set.problem === "unreachable"
        ? apiError(c, "upstream_unreachable")
        : refuse(
            c,
            `${byHand(set.problem, url)}, and a new secret from POST ${secretRoute(repo.id)}`,
          );
    }
    return c.json({ url, secret, managed: true } satisfies AutoReviewWebhookView);
  });

  // For the hook added by hand: the secret replaces the one any existing hook
  // proves itself with, so that hook is refused until it is given this one.
  // A hook ocra added is the user's from then on: it is no longer updated or
  // removed by ocra, since only the user can give it the new secret.
  route.post(
    "/repos/:id/webhook/secret",
    requireSession(["web"]),
    perMinute("settings"),
    async (c) => {
      const found = await gitlabRepo(c, "only a GitLab project's webhook has a secret set here");
      if ("refused" in found) return found.refused;
      const { repo } = found;
      const secret = randomToken("ocra_hook_");
      const replaced = await c.var.data.update(
        "reviewRepos",
        repo.id,
        { webhookSecretHash: await sha256Hex(secret), webhookId: null },
        { webhookSecretHash: repo.webhookSecretHash },
      );
      if (!replaced) return apiError(c, "stale");
      await audit(c.var.data, "auto_review.webhook_secret_rotated", { repo: repo.fullName });
      return c.json({
        url: gitlabHookUrl(c.req.url),
        secret,
        events: HAND_EVENTS,
      } satisfies AutoReviewWebhookSecretView);
    },
  );

  return route;
}
