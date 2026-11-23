import { Hono } from "hono";
import { apiError } from "../http.js";
import { requireSession } from "../session.js";
import type { ImpactView } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { buildView, pullNumber } from "./impact-route.js";

/**
 * GET /:id/impact?pull=N where the server cannot read a graph itself (a
 * Worker's request has no time to parse one): what a runner worked out when
 * it last reviewed the pull request (./runner-api.ts), as it was kept.
 */
export const keptImpactRoute = new Hono<AppEnv>().get(
  "/:id/impact",
  requireSession(["web"]),
  async (c) => {
    const pull = pullNumber.safeParse(c.req.query("pull"));
    if (!pull.success) return apiError(c, "not_found");
    const repo = await c.var.data.get("graphRepos", c.req.param("id"));
    if (!repo) return apiError(c, "not_found");
    const kept = await c.var.data.graphs.keptImpact(repo.id, pull.data);
    if (kept) return c.body(kept, 200, { "content-type": "application/json" });
    const builds = await c.var.data.graphs.latestBuilds();
    const latest = builds.find((b) => b.graphRepoId === repo.id);
    return c.json({
      pull: null,
      graph: null,
      // A finished build has a graph, which the next review reads.
      build: latest?.state === "done" ? null : buildView(latest, undefined),
      symbols: [],
      more: 0,
    } satisfies ImpactView);
  },
);
