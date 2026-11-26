import { GRAPH_COMMIT_HEADER } from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { claimBuild } from "../db/graphs.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import type { BotCredential, BotTokens } from "../platforms/bot.js";
import type { CodePlatform } from "../platforms/platform.js";
import type { CodePlatformKind } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { impactViewSchema } from "./impact-schema.js";
import type { RemoteGraphs } from "./routes.js";
import { BUILD_FAILURES, BUILD_LEASE_MS, type BuildFailure, failBuild } from "./runner.js";

// A remote runner's graph calls (docs/runner.md), behind the runner token:
// it is given the next queued build with its claim of a hosted job
// (src/auto-review/runner-api.ts), reads the graph the server keeps of the
// repository, builds the commit's from a clone (src/node/graph-job.ts) and
// sends it back; after a review it sends what the pull request reaches.

/** A queued build as a runner takes it: the commit, and a bot credential to clone it with. */
export type GraphAssignment = {
  id: string;
  accountId: string;
  attempts: number;
  leaseUntil: Date;
  graphRepoId: string;
  commit: string;
  repo: { platform: CodePlatformKind; url: string; fullName: string };
  bot: BotCredential;
};

export type BuildSource = {
  db: Db;
  platforms: readonly CodePlatform[];
  bots: BotTokens;
  recover?: boolean;
  now?: Date;
};

/** Builds refused in a row (a repository or bot gone) before a claim answers none. */
const MAX_REFUSED = 3;
/** What a pull request reaches, as JSON: 60 symbols of 200 uses each fit. */
const MAX_IMPACT_BYTES = 1024 * 1024;

const ref = { accountId: z.string().min(1).max(100), attempts: z.number().int().min(1) };
const count = z.number().int().min(0);
const built = z.object({
  ...ref,
  // The gzipped graph in base64, kept as it is sent.
  graph: z.base64(),
  files: count,
  parsed: count,
  reused: count,
  skipped: count,
});
const failed = z.object({ ...ref, failure: z.enum(BUILD_FAILURES) });
const impact = z.object({
  accountId: ref.accountId,
  graphRepoId: z.string().min(1).max(100),
  number: z
    .number()
    .int()
    .min(1)
    .max(2 ** 31 - 1),
  view: impactViewSchema,
});

/**
 * What the bot's token is chosen for: on GitLab the account's enrolled
 * repository of the graph's project where there is one, so that the
 * project's own access token clones it as it reviews it; else the graph's.
 */
async function enrolledOrKept(data: Scoped, repo: Row<"graphRepos">) {
  const { platform, host, platformRepoId } = repo;
  if (platform !== "gitlab") return repo;
  return (await data.findOne("reviewRepos", { platform, host, platformRepoId })) ?? repo;
}

/** Claims the next due build a runner can clone; undefined when none is. */
export async function assignBuild(source: BuildSource): Promise<GraphAssignment | undefined> {
  for (let refused = 0; refused < MAX_REFUSED; refused++) {
    const now = source.now ?? new Date();
    const build = await claimBuild(
      source.db,
      now,
      BUILD_LEASE_MS,
      refused === 0 ? source.recover : false,
    );
    if (!build) return undefined;
    const data = scoped(source.db, build.accountId);
    const repo = await data.get("graphRepos", build.graphRepoId);
    const platform =
      repo && source.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
    const bot = platform && (await source.bots.forRepo(await enrolledOrKept(data, repo)));
    if (repo && platform && bot) {
      return {
        id: build.id,
        accountId: build.accountId,
        attempts: build.attempts,
        leaseUntil: build.leaseUntil,
        graphRepoId: repo.id,
        commit: build.commit,
        repo: { platform: platform.kind, url: platform.url, fullName: repo.fullName },
        bot,
      };
    }
    const reason: BuildFailure = !repo ? "repo_gone" : !platform ? "platform_gone" : "no_bot";
    await failBuild(source.db, build, reason, now);
  }
  return undefined;
}

export function graphRunnerApi(remote: RemoteGraphs) {
  const route = new Hono<AppEnv>();
  // Base64 holds three bytes in four characters; the rest of the body is counts.
  const maxBody = Math.ceil((remote.maxGraphBytes * 4) / 3) + 4096;

  // The newest graph kept of the repository, gzipped as it is kept: what a build or a review starts from.
  route.get("/repos/:id/graph", async (c) => {
    const data = scoped(c.var.db, c.req.query("account") ?? "");
    const graph = await data.graphs.newestGraph(c.req.param("id"));
    if (!graph) return apiError(c, "not_found");
    return c.body(graph.content, 200, {
      "content-type": "application/gzip",
      [GRAPH_COMMIT_HEADER]: graph.commit,
    });
  });

  route.post("/builds/:id", jsonBody(z.union([built, failed]), { max: maxBody }), async (c) => {
    const body = c.req.valid("json");
    const build = { id: c.req.param("id"), accountId: body.accountId, attempts: body.attempts };
    const now = new Date();
    if ("failure" in body) {
      await failBuild(c.var.db, build, body.failure, now);
      return c.json({ kept: false });
    }
    const { graph: content, files, parsed, reused, skipped } = body;
    if (Buffer.byteLength(content, "base64") > remote.maxGraphBytes) {
      await failBuild(c.var.db, build, "too_large", now);
      return c.json({ kept: false });
    }
    const kept = await scoped(c.var.db, build.accountId).graphs.finishBuild(
      build.id,
      build.attempts,
      { content, files, parsed, reused, skipped, truncated: false },
      now,
      false,
    );
    return c.json({ kept });
  });

  route.post("/impacts", jsonBody(impact, { max: MAX_IMPACT_BYTES }), async (c) => {
    const { accountId, graphRepoId, number, view } = c.req.valid("json");
    await scoped(c.var.db, accountId).graphs.keepImpact(
      graphRepoId,
      number,
      view.pull.head,
      JSON.stringify(view),
      new Date(),
    );
    return c.json({ ok: true });
  });

  return route;
}
