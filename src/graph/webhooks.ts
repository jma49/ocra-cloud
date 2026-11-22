import { Hono } from "hono";
import { z } from "zod";
import { sameText, sha256Hex } from "../crypto.js";
import { reposForPush } from "../db/graphs.js";
import { scoped } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { COMMIT_ID } from "../platforms/contents.js";
import { gitlabClientOf } from "../platforms/registry.js";
import type { AppEnv } from "../types.js";
import type { GraphService } from "./routes.js";

// Pushes to a repository's default branch queue a graph build of the new
// commit for every account that added the repository. Only trusted
// revisions are built (ADR-0041, 5): never a pull request's head.

/** A push hook's body: GitHub caps a push's listed commits at 20. */
export const MAX_HOOK_BODY = 2 * 1024 * 1024;

type Push = {
  platformRepoId: string;
  fullName: string;
  ref: string;
  defaultBranch: string;
  commit: string;
};

const githubPush = z.object({
  ref: z.string(),
  after: z.string(),
  repository: z.object({ id: z.number(), full_name: z.string(), default_branch: z.string() }),
});

const gitlabPush = z.object({
  ref: z.string(),
  checkout_sha: z.string().nullable(),
  project: z.object({
    id: z.number(),
    path_with_namespace: z.string(),
    default_branch: z.string(),
  }),
});

/** A GitHub App webhook's push (src/webhooks.ts verified it): queues the graph builds it calls for. */
export async function queueGithubPush(
  db: AppEnv["Variables"]["db"],
  service: GraphService,
  body: unknown,
): Promise<number> {
  const parsed = githubPush.safeParse(body);
  if (!parsed.success) return 0;
  const push = parsed.data;
  const repos = await reposForPush(db, "github", "github.com", String(push.repository.id));
  return queue(db, repos, service, {
    platformRepoId: String(push.repository.id),
    fullName: push.repository.full_name,
    ref: push.ref,
    defaultBranch: push.repository.default_branch,
    commit: push.after,
  });
}

/** GitLab's project hooks, each proven by the secret of the repository it names. */
export function graphWebhooks(service: GraphService) {
  const hooks = new Hono<AppEnv>();

  hooks.post(
    "/gitlab",
    jsonBody(z.union([gitlabPush, z.looseObject({})]), { max: MAX_HOOK_BODY }),
    async (c) => {
      const client = gitlabClientOf(c.env);
      if (!client) return apiError(c, "not_found");
      const token = c.req.header("x-gitlab-token");
      if (!token) return apiError(c, "unauthenticated");
      const body = c.req.valid("json");
      if (c.req.header("x-gitlab-event") !== "Push Hook" || !("project" in body)) {
        return c.json({ queued: 0 }, 202);
      }
      const push = gitlabPush.parse(body);
      const hash = await sha256Hex(token);
      const repos = (
        await reposForPush(c.var.db, "gitlab", new URL(client.url).host, String(push.project.id))
      ).filter((r) => r.webhookSecretHash && sameText(r.webhookSecretHash, hash));
      if (repos.length === 0) return apiError(c, "unauthenticated");
      const queued = await queue(c.var.db, repos, service, {
        platformRepoId: String(push.project.id),
        fullName: push.project.path_with_namespace,
        ref: push.ref,
        defaultBranch: push.project.default_branch,
        commit: push.checkout_sha ?? "",
      });
      return c.json({ queued }, 202);
    },
  );

  return hooks;
}

async function queue(
  db: AppEnv["Variables"]["db"],
  repos: Awaited<ReturnType<typeof reposForPush>>,
  service: GraphService,
  push: Push,
): Promise<number> {
  // A deleted branch pushes the zero commit; a tag or another branch is not the graph's.
  if (push.ref !== `refs/heads/${push.defaultBranch}`) return 0;
  if (!COMMIT_ID.test(push.commit) || /^0+$/.test(push.commit)) return 0;
  let queued = 0;
  for (const repo of repos) {
    const data = scoped(db, repo.accountId);
    if (repo.fullName !== push.fullName || repo.branch !== push.defaultBranch) {
      await data.update("graphRepos", repo.id, {
        fullName: push.fullName,
        branch: push.defaultBranch,
      });
    }
    if (await data.graphs.queueBuild(repo.id, push.commit)) queued++;
  }
  if (queued > 0) service.kick();
  return queued;
}
