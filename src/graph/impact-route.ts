import type { CodeGraph } from "@open-cr-agent/code-graph";
import { Hono } from "hono";
import { z } from "zod";
import type { BuildSummary } from "../db/graphs.js";
import { apiError } from "../http.js";
import type { PullChanges } from "../platforms/changes.js";
import { accessToken } from "../platforms/links.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import type { ImpactView } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { gunzip } from "./gzip.js";
import { impactOf, withCode } from "./impact.js";

/** Reads a stored graph's text; undefined for one of a format it does not read. */
export type GraphParser = (text: string) => CodeGraph | undefined;

/** Uses whose code line is read per request, from at most as many files. */
const CODE_LINES = 40;
const MAX_FILE_BYTES = 1_000_000;

const pullNumber = z.coerce
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);

/** GET /:id/impact?pull=N: what pull request N of the graph repository :id reaches. */
export function impactRoute(parse: GraphParser) {
  const route = new Hono<AppEnv>();
  route.get("/:id/impact", requireSession(["web"]), perMinute("platform"), async (c) => {
    const pull = pullNumber.safeParse(c.req.query("pull"));
    if (!pull.success) return apiError(c, "not_found");
    const repo = await c.var.data.get("graphRepos", c.req.param("id"));
    if (!repo) return apiError(c, "not_found");
    const platform = platformsOf(c.env, c.req.url).find(
      (p) => p.kind === repo.platform && p.host === repo.host,
    );
    if (!platform) return apiError(c, "not_found");
    const token = await accessToken(c.var.data, c.env, platform);
    if (!token) return apiError(c, "github_user");
    const [changes, builds, stored] = await Promise.all([
      platform.changes.changes(token, repo.fullName, pull.data),
      c.var.data.graphs.latestBuilds(),
      c.var.data.graphs.newestGraph(repo.id),
    ]);
    if (!changes) return apiError(c, "not_found");
    const latest = builds.find((b) => b.graphRepoId === repo.id);
    const graph = stored?.content ? parse(await gunzip(new Uint8Array(stored.content))) : undefined;
    const readLines = async (path: string) => {
      const key = graph?.files.get(path);
      if (!key) return undefined;
      const bytes = await platform.contents.blob(
        token,
        repo,
        key.slice(key.lastIndexOf(":") + 1),
        MAX_FILE_BYTES,
      );
      return bytes && new TextDecoder().decode(bytes).split("\n");
    };
    const impact = graph ? impactOf(graph, changes.files) : { symbols: [], more: 0 };
    const view = {
      pull: pullView(changes),
      graph:
        stored && graph
          ? {
              commit: stored.commit,
              current: stored.commit === changes.base,
              truncated: stored.truncated,
              files: stored.files,
            }
          : null,
      build: buildView(latest, stored?.commit),
      symbols: await withCode(impact.symbols, CODE_LINES, readLines),
      more: impact.more,
    } satisfies ImpactView;
    return c.json(view);
  });
  return route;
}

const pullView = (changes: PullChanges): ImpactView["pull"] => ({
  base: changes.base,
  head: changes.head,
  files: changes.files.length,
  truncated: changes.truncated,
  unread: changes.files.filter((f) => f.hunks === null && f.status === "modified").length,
});

/** The newest build, when it is not the graph answered from. */
function buildView(latest: BuildSummary | undefined, shown: string | undefined) {
  if (!latest || (latest.state === "done" && latest.commit === shown)) return null;
  return { state: latest.state, commit: latest.commit, error: latest.error };
}
