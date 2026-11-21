import { Hono } from "hono";
import { z } from "zod";
import { randomToken, sha256Hex } from "../crypto.js";
import type { BuildSummary } from "../db/graphs.js";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { COMMIT_ID } from "../platforms/contents.js";
import { accessToken } from "../platforms/links.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import { CODE_PLATFORMS, type GraphRepoView } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { gunzip } from "./gzip.js";
import type { GraphPolicy } from "./policy.js";
import { graphWebhooks } from "./webhooks.js";

/** What a host that builds graphs gives the API. */
export type GraphService = {
  policy: Exclude<GraphPolicy, "off">;
  /** The GitHub App's webhook secret; without it GitHub pushes are not taken. */
  githubWebhookSecret?: string;
  /** Wakes the build runner after a build is queued. */
  kick: () => void;
};

const MAX_GRAPH_REPOS = 100;

const addSchema = z.object({
  platform: z.enum(CODE_PLATFORMS),
  // owner/repo on GitHub, group/subgroup/project on GitLab.
  fullName: z
    .string()
    .max(400)
    .regex(/^[\w.-]+(?:\/[\w.-]+)+$/, "a repository path")
    .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), "a repository path"),
  consent: z.boolean().optional(),
});

const repoView = (r: Row<"graphRepos">, latest: BuildSummary | undefined) =>
  ({
    id: r.id,
    platform: r.platform,
    host: r.host,
    fullName: r.fullName,
    branch: r.branch,
    latest: latest
      ? {
          commit: latest.commit,
          state: latest.state,
          files: latest.files,
          bytes: latest.bytes,
          truncated: latest.truncated,
          error: latest.error,
          finishedAt: latest.finishedAt?.toISOString() ?? null,
        }
      : null,
  }) satisfies GraphRepoView;

export function graphsRoute(service: GraphService) {
  const route = new Hono<AppEnv>();

  route.route("/webhooks", graphWebhooks(service));

  route.get("/repos", requireSession(["web", "cli"]), async (c) => {
    const graphs = c.var.data.graphs;
    const [repos, latest] = await Promise.all([
      c.var.data.find("graphRepos", {}, MAX_GRAPH_REPOS),
      graphs.latestBuilds(),
    ]);
    const byRepo = new Map(latest.map((b) => [b.graphRepoId, b]));
    return c.json({ repos: repos.map((r) => repoView(r, byRepo.get(r.id))) });
  });

  route.post("/repos", requireSession(), perMinute("settings"), jsonBody(addSchema), async (c) => {
    const body = c.req.valid("json");
    if (service.policy === "opt-in" && body.consent !== true) {
      return apiError(c, "invalid_body", {
        issues: [{ path: ["consent"], message: "keeping a code graph needs the owner's consent" }],
      });
    }
    const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === body.platform);
    if (!platform) return apiError(c, "not_found");
    const token = await accessToken(c.var.data, c.env, platform);
    if (!token) return apiError(c, "github_user");
    const head = await platform.contents.head(token, body.fullName);
    if (!head || !COMMIT_ID.test(head.commit)) return apiError(c, "not_found");
    // GitLab's project hook proves itself with a secret of its own;
    // GitHub's with the App's signature.
    const secret = platform.kind === "gitlab" ? randomToken("ocra_hook_") : undefined;
    const id = await c.var.data.graphs.addRepo(
      {
        platform: platform.kind,
        host: platform.host,
        platformRepoId: head.platformRepoId,
        fullName: head.fullName,
        branch: head.branch,
        webhookSecretHash: secret ? await sha256Hex(secret) : null,
        consentedAt: body.consent ? new Date() : null,
      },
      MAX_GRAPH_REPOS,
    );
    if (!id) {
      return apiError(c, "invalid_body", {
        issues: [{ path: [], message: `at most ${MAX_GRAPH_REPOS} repositories keep a graph` }],
      });
    }
    if (await c.var.data.graphs.queueBuild(id, head.commit)) service.kick();
    const [repo, latest] = await Promise.all([
      c.var.data.get("graphRepos", id),
      c.var.data.graphs.latestBuilds(),
    ]);
    if (!repo) return apiError(c, "not_found");
    return c.json({
      repo: repoView(
        repo,
        latest.find((b) => b.graphRepoId === id),
      ),
      webhook: {
        url: new URL(`/api/graphs/webhooks/${platform.kind}`, c.req.url).toString(),
        ...(secret ? { secret } : {}),
      },
    });
  });

  route.delete("/repos/:id", requireSession(), async (c) => {
    return c.json({ removed: await c.var.data.remove("graphRepos", c.req.param("id")) });
  });

  route.delete("/repos/:id/graphs", requireSession(), async (c) => {
    const repo = await c.var.data.get("graphRepos", c.req.param("id"));
    if (!repo) return apiError(c, "not_found");
    return c.json({ removed: await c.var.data.graphs.purgeBuilds(repo.id) });
  });

  // The serialized graph, for `ocra review --graph`: of the commit, or the newest.
  route.get("/repos/:id/graph", requireSession(["web", "cli"]), async (c) => {
    const commit = c.req.query("commit");
    if (commit !== undefined && !COMMIT_ID.test(commit)) return apiError(c, "not_found");
    const repo = await c.var.data.get("graphRepos", c.req.param("id"));
    if (!repo) return apiError(c, "not_found");
    const graph = await c.var.data.graphs.newestGraph(repo.id, commit);
    if (!graph?.content) return apiError(c, "not_found");
    const bytes = new Uint8Array(graph.content);
    const headers = { "content-type": "application/json", "x-ocra-graph-commit": graph.commit };
    if (/\bgzip\b/.test(c.req.header("accept-encoding") ?? "")) {
      return c.body(bytes, 200, { ...headers, "content-encoding": "gzip" });
    }
    return c.body(await gunzip(bytes), 200, headers);
  });

  return route;
}
