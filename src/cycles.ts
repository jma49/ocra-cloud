import { type Context, Hono } from "hono";
import { z } from "zod";
import { apiError, queryDays } from "./http.js";
import { MAX_CYCLE_PULLS, type MergedPull } from "./platforms/cycles.js";
import { accessToken } from "./platforms/links.js";
import { platformsOf } from "./platforms/registry.js";
import { repoRef } from "./pull-ref.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import { type CyclePull, type CycleView, quantile, type Spread } from "./shared/index.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";

// Pull request cycle time on the Insights page: merged pull requests read
// live from the platform as the user, timed from opened to first review by
// someone else and to merged. Nothing read is kept.

export const cycles = new Hono<AppEnv>();

const MAX_DAYS = 90;
const query = z.object(repoRef).partial({ repo: true });

export const spread = (values: readonly number[]): Spread => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) };
};

function timed(p: MergedPull): CyclePull {
  const opened = Date.parse(p.createdAt);
  return {
    ...p,
    toFirstReviewMs: p.firstReviewAt ? Math.max(0, Date.parse(p.firstReviewAt) - opened) : null,
    toMergeMs: Math.max(0, Date.parse(p.mergedAt) - opened),
  };
}

cycles.get("/", requireSession(["web"]), perMinute("platform"), async (c: Context<AppEnv>) => {
  const q = query.safeParse(c.req.query());
  if (!q.success) return apiError(c, "not_found");
  const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === q.data.platform);
  if (!platform) return apiError(c, "not_found");
  const token = await accessToken(c.var.data, c.env, platform);
  if (!token) return apiError(c, "github_user");
  const days = queryDays(c, 30, MAX_DAYS);
  const since = new Date(Date.now() - days * DAY);
  const scope = q.data.repo ? { repo: q.data.repo } : ({ mine: true } as const);
  const merged = await platform.cycles.merged(token, scope, since);
  if (!merged) return apiError(c, "upstream_unreachable");
  const pulls = merged.map(timed);
  const reviewed = pulls.flatMap((p) => (p.toFirstReviewMs === null ? [] : [p.toFirstReviewMs]));
  return c.json({
    platform: platform.kind,
    repo: q.data.repo ?? null,
    days,
    pulls,
    unreviewed: pulls.length - reviewed.length,
    toFirstReview: spread(reviewed),
    toMerge: spread(pulls.map((p) => p.toMergeMs)),
    capped: merged.length >= MAX_CYCLE_PULLS,
  } satisfies CycleView);
});
