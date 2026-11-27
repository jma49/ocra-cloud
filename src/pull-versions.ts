import { type Context, Hono } from "hono";
import { z } from "zod";
import { apiError } from "./http.js";
import type { CodePlatform } from "./platforms/platform.js";
import { byKind, reach } from "./pull-page.js";
import { pullRef } from "./pull-ref.js";
import { fileView, shaOf } from "./pull-since.js";
import { numberVersions } from "./pull-versions/merge.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import type { PullVersionCompareView, PullVersionsView } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's versions, each head it was pushed to: those its
// enrolled repository's webhooks kept (src/pull-versions/hooks.ts) with
// those the platform still lists, read live as the user; and the diff
// between any two heads, along the history when one is the other's
// ancestor, else tree to tree. Nothing read is stored.

export const pullVersions = new Hono<AppEnv>();

const listQuery = z.object(pullRef);
const compareQuery = z.object({ ...pullRef, from: shaOf, to: shaOf });

/** The heads the account's enrolled repository kept for the pull request; none when it is not enrolled. */
async function keptOf(c: Context<AppEnv>, platform: CodePlatform, repo: string, number: number) {
  const enrolled = await c.var.data.findOne("reviewRepos", {
    platform: platform.kind,
    host: platform.host,
    fullName: repo,
  });
  return enrolled ? c.var.data.pullVersions.of(enrolled.id, number) : [];
}

/** The heads ocra kept and the platform lists for the pull request, to number at its head. */
export async function versionSources(
  c: Context<AppEnv>,
  platform: CodePlatform,
  token: string,
  repo: string,
  number: number,
) {
  const [listed, kept] = await Promise.all([
    platform.versions.list(token, repo, number),
    keptOf(c, platform, repo, number),
  ]);
  return { kept, listed };
}

pullVersions.get("/versions", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = listQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const { repo, number } = ref.data;
  const [pull, { kept, listed }] = await Promise.all([
    platform.changes.changes(token, repo, number, 0),
    versionSources(c, platform, token, repo, number),
  ]);
  if (!pull) return apiError(c, "not_found");
  const head = pull.head.toLowerCase();
  const { versions, complete } = numberVersions(kept, listed, head, new Date());
  return c.json({
    platform: platform.kind,
    repo,
    number,
    head,
    versions,
    complete,
  } satisfies PullVersionsView);
});

pullVersions.get("/versions/compare", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = compareQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const { repo, number, from, to } = ref.data;
  const pull = await platform.changes.changes(token, repo, number, 0);
  if (!pull) return apiError(c, "not_found");
  const view = { platform: platform.kind, repo, number, from, to };
  if (from === to) {
    return c.json({
      ...view,
      state: "same",
      compare: null,
      lines: true,
      files: [],
      truncated: false,
    } satisfies PullVersionCompareView);
  }
  const along = await platform.since.diff(token, repo, from, to);
  const rewritten = along?.state === "rebased";
  const diff = rewritten ? await platform.versions.trees(token, repo, from, to) : along;
  const changed = diff?.state === "changes" ? diff : null;
  return c.json({
    ...view,
    state: changed ? "changes" : "unavailable",
    compare: changed ? (rewritten ? "trees" : "history") : null,
    // GitHub's trees name each file's blob, not its lines.
    lines: !(rewritten && platform.kind === "github"),
    files: (changed?.files ?? []).map((f) => fileView(f)),
    truncated: changed?.truncated ?? false,
  } satisfies PullVersionCompareView);
});
