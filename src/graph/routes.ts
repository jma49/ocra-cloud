import { GRAPH_COMMIT_HEADER, MAX_GRAPH_REPOS } from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import { z } from "zod";
import { randomToken, sha256Hex } from "../crypto.js";
import type { BuildSummary } from "../db/graphs.js";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { COMMIT_ID } from "../platforms/contents.js";
import { accessToken } from "../platforms/links.js";
import { type CodePlatform, repoIdentity } from "../platforms/platform.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import { CODE_PLATFORMS, type GraphPolicy, type GraphRepoView } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { gunzip } from "./gzip.js";
import { graphWebhooks } from "./webhooks.js";

/** What a host that keeps graphs gives the API. */
export type GraphService = {
  policy: Exclude<GraphPolicy, "off">;
  /** Wakes the build runner after a build is queued. */
  kick: () => void;
  /** GET /repos/:id/impact, as this host answers it: from the graph, or from what a runner kept. */
  impact: Hono<AppEnv>;
  /** Set where remote runners build the graphs (./runner-api.ts) and the database is small. */
  remote?: RemoteGraphs;
};

export type RemoteGraphs = {
  /** Repositories an account may keep a graph of. */
  maxRepos: number;
  /** The largest gzipped graph kept. */
  maxGraphBytes: number;
};

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

const repoView = (
  r: Row<"graphRepos">,
  latest: BuildSummary | undefined,
  platforms: readonly CodePlatform[],
) => {
  const base =
    platforms.find((p) => p.kind === r.platform && p.host === r.host)?.url ?? `https://${r.host}`;
  return {
    id: r.id,
    platform: r.platform,
    host: r.host,
    fullName: r.fullName,
    url: `${base}/${r.fullName}`,
    identity: repoIdentity({ url: base }, r.fullName),
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
  } satisfies GraphRepoView;
};

/**
 * Bytes that are already gzipped, sent as they are. A Worker compresses a
 * body whose headers name an encoding unless told it already is.
 */
const gzipped = (bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string>) =>
  new Response(bytes, {
    headers: { ...headers, "content-encoding": "gzip" },
    encodeBody: "manual",
  });

export function graphsRoute(service: GraphService) {
  const route = new Hono<AppEnv>();
  const maxRepos = service.remote?.maxRepos ?? MAX_GRAPH_REPOS;

  route.route("/webhooks", graphWebhooks(service));
  route.route("/repos", service.impact);

  route.get("/repos", requireSession(["web", "cli"]), async (c) => {
    const graphs = c.var.data.graphs;
    const [repos, latest] = await Promise.all([
      c.var.data.find("graphRepos", {}, maxRepos),
      graphs.latestBuilds(),
    ]);
    const byRepo = new Map(latest.map((b) => [b.graphRepoId, b]));
    const platforms = platformsOf(c.env, c.req.url);
    return c.json({ repos: repos.map((r) => repoView(r, byRepo.get(r.id), platforms)) });
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
      maxRepos,
    );
    if (!id) {
      return apiError(c, "invalid_body", {
        issues: [{ path: [], message: `at most ${maxRepos} repositories keep a graph` }],
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
        [platform],
      ),
      webhook: {
        url: new URL(
          platform.kind === "gitlab" ? "/api/graphs/webhooks/gitlab" : "/api/webhooks/github",
          c.req.url,
        ).toString(),
        ...(secret ? { secret } : {}),
      },
    });
  });

  route.delete("/repos/:id", requireSession(), async (c) => {
    return c.json({ removed: await c.var.data.remove("graphRepos", c.req.param("id")) });
  });

  // Builds the default branch's head again, as of now: after a failed
  // build, or to pick up a push the server missed.
  route.post("/repos/:id/builds", requireSession(), perMinute("settings"), async (c) => {
    const repo = await c.var.data.get("graphRepos", c.req.param("id"));
    if (!repo) return apiError(c, "not_found");
    const platform = platformsOf(c.env, c.req.url).find(
      (p) => p.kind === repo.platform && p.host === repo.host,
    );
    if (!platform) return apiError(c, "not_found");
    const token = await accessToken(c.var.data, c.env, platform);
    if (!token) return apiError(c, "github_user");
    const head = await platform.contents.head(token, repo.fullName);
    if (!head || head.platformRepoId !== repo.platformRepoId || !COMMIT_ID.test(head.commit)) {
      return apiError(c, "not_found");
    }
    const queued = await c.var.data.graphs.rebuild(repo.id, head.commit, new Date());
    if (queued) service.kick();
    const latest = await c.var.data.graphs.latestBuilds();
    return c.json({
      queued,
      repo: repoView(
        repo,
        latest.find((b) => b.graphRepoId === repo.id),
        [platform],
      ),
    });
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
    if (!graph) return apiError(c, "not_found");
    const headers = { "content-type": "application/json", [GRAPH_COMMIT_HEADER]: graph.commit };
    if (/\bgzip\b/.test(c.req.header("accept-encoding") ?? ""))
      return gzipped(graph.content, headers);
    return c.body(await gunzip(graph.content), 200, headers);
  });

  return route;
}
