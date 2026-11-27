import { Hono } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { DEFAULT_SCOPE, type OpenPull } from "./db/review-targets.js";
import type { Row, Scoped } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import { repoName } from "./pull-ref.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import {
  type AtRiskPullView,
  type AtRiskView,
  MAX_FIRST_REVIEW_HOURS,
  MAX_MERGE_DAYS,
  NEAR_TARGET,
  type ReviewTargetKind,
  type ReviewTargets,
  type ReviewTargetsView,
} from "./shared/index.js";
import { DAY, HOUR } from "./time.js";
import type { AppEnv } from "./types.js";

// Review targets of the account's enrolled repositories (first review within
// hours, merge within days of being ready for review; an account default and
// a repository's own in its place) and the open pull requests out of draft
// that are near or past one, read only from what the webhooks stored: no
// platform call. The hourly run tells pull_at_risk of the same list
// (src/notify/at-risk.ts).

/** Enrolled repositories, and so target rows, an account has at most (and the default). */
const MAX_ROWS = 101;
/** Open pull requests one reading takes. */
const CAP = 2_000;
const LISTED = 200;

const NONE: ReviewTargets = { firstReviewHours: null, mergeDays: null };

const targetsBody = z.object({
  firstReviewHours: z.number().int().min(1).max(MAX_FIRST_REVIEW_HOURS).nullable(),
  mergeDays: z.number().int().min(1).max(MAX_MERGE_DAYS).nullable(),
});

const viewOf = (t: ReviewTargets) =>
  ({ firstReviewHours: t.firstReviewHours, mergeDays: t.mergeDays }) satisfies ReviewTargets;

const targetsOf = (row: Row<"reviewTargets">): ReviewTargets => ({
  firstReviewHours: row.firstReviewHours,
  mergeDays: row.mergeDays,
});

/** A pull request near or past one of its targets, before its waiting reviewers are read. */
export type AtRisk = {
  pull: OpenPull;
  target: ReviewTargetKind;
  state: "past" | "near";
  since: number;
  due: number;
  /** When it came near its target. */
  nearAt: number;
};

/** Each repository's targets: its own, or the default. */
async function targetsByRepo(data: Scoped) {
  const rows = await data.find("reviewTargets", {}, MAX_ROWS);
  const fallback = rows.find((r) => r.scope === DEFAULT_SCOPE);
  const own = new Map(
    rows.filter((r) => r.reviewRepoId !== null).map((r) => [r.reviewRepoId, targetsOf(r)]),
  );
  const set = rows.some((r) => r.firstReviewHours !== null || r.mergeDays !== null);
  return {
    set,
    of: (reviewRepoId: string) => own.get(reviewRepoId) ?? (fallback ? targetsOf(fallback) : NONE),
  };
}

function atRisk(
  pull: OpenPull,
  target: ReviewTargetKind,
  since: number,
  span: number,
  now: number,
): AtRisk | null {
  const due = since + span;
  const nearAt = since + span * NEAR_TARGET;
  if (now < nearAt) return null;
  return { pull, target, state: now >= due ? "past" : "near", since, due, nearAt };
}

/** The pulls near or past a target: past first, then the earliest due. */
function pullsAtRisk(
  pulls: readonly OpenPull[],
  of: (reviewRepoId: string) => ReviewTargets,
  now: number,
): AtRisk[] {
  const found: AtRisk[] = [];
  for (const p of pulls) {
    const t = of(p.reviewRepoId);
    if (t.firstReviewHours !== null && p.firstReviewAt === null) {
      const since = p.reopenedAt ?? p.readyAt;
      const hit = atRisk(p, "first_review", since, t.firstReviewHours * HOUR, now);
      if (hit) found.push(hit);
    }
    if (t.mergeDays !== null) {
      const hit = atRisk(p, "merge", p.readyAt, t.mergeDays * DAY, now);
      if (hit) found.push(hit);
    }
  }
  return found.sort(
    (a, b) => (a.state === b.state ? 0 : a.state === "past" ? -1 : 1) || a.due - b.due,
  );
}

/** What the account's targets put at risk now, of repoIds or every enrolled repository. */
export async function readAtRisk(
  data: Scoped,
  repoIds: readonly string[] | null,
  now: number,
  retentionDays: number,
) {
  const targets = await targetsByRepo(data);
  if (!targets.set) return { set: false, found: [] as AtRisk[], capped: false };
  const since = new Date(now - retentionDays * DAY);
  const pulls = await data.reviewTargets.openPulls(since, repoIds, CAP);
  return { set: true, found: pullsAtRisk(pulls, targets.of, now), capped: pulls.length >= CAP };
}

export const atRiskRoute = new Hono<AppEnv>();

atRiskRoute.get("/", requireSession(["web"]), async (c) => {
  const repoQuery = c.req.query("repo");
  const repo = repoQuery === undefined ? null : repoName.safeParse(repoQuery);
  if (repo && !repo.success) return apiError(c, "not_found");
  const data = c.var.data;
  let repoIds: string[] | null = null;
  if (repo?.success) {
    repoIds = (await data.find("reviewRepos", { fullName: repo.data }, 10)).map((r) => r.id);
    if (repoIds.length === 0) return apiError(c, "not_found");
  }
  const { set, found, capped } = await readAtRisk(
    data,
    repoIds,
    Date.now(),
    config(c.env).retentionDays,
  );
  const listed = found.slice(0, LISTED);
  const asks = await data.reviewTargets.waitingOn(listed.map((a) => a.pull));
  const waiting = new Map<string, string[]>();
  for (const a of asks) {
    const key = `${a.reviewRepoId}#${a.number}`;
    const list = waiting.get(key) ?? [];
    if (!list.includes(a.login)) list.push(a.login);
    waiting.set(key, list);
  }
  return c.json({
    repo: repo?.success ? repo.data : null,
    pulls: listed.map(
      (a): AtRiskPullView => ({
        platform: a.pull.platform,
        repo: a.pull.repo,
        number: a.pull.number,
        title: a.pull.title,
        author: a.pull.author,
        target: a.target,
        state: a.state,
        since: new Date(a.since).toISOString(),
        due: new Date(a.due).toISOString(),
        waitingOn: waiting.get(`${a.pull.reviewRepoId}#${a.pull.number}`) ?? [],
      }),
    ),
    targetsSet: set,
    capped,
  } satisfies AtRiskView);
});

export const reviewTargetsRoute = new Hono<AppEnv>();

reviewTargetsRoute.get("/", requireSession(), async (c) => {
  const data = c.var.data;
  const [rows, repos] = await Promise.all([
    data.find("reviewTargets", {}, MAX_ROWS),
    data.find("reviewRepos", {}, MAX_ROWS),
  ]);
  const fallback = rows.find((r) => r.scope === DEFAULT_SCOPE);
  const own = new Map(rows.map((r) => [r.reviewRepoId, r]));
  return c.json({
    default: fallback ? targetsOf(fallback) : NONE,
    repos: repos
      .map((r) => {
        const row = own.get(r.id);
        return {
          reviewRepoId: r.id,
          platform: r.platform,
          fullName: r.fullName,
          targets: row ? targetsOf(row) : null,
        };
      })
      .sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0)),
  } satisfies ReviewTargetsView);
});

reviewTargetsRoute.put(
  "/default",
  requireSession(["web"]),
  perMinute("settings"),
  jsonBody(targetsBody),
  async (c) => {
    const targets = c.req.valid("json");
    await c.var.data.reviewTargets.setDefault(targets, new Date());
    return c.json(viewOf(targets));
  },
);

reviewTargetsRoute.put(
  "/repos/:id",
  requireSession(["web"]),
  perMinute("settings"),
  jsonBody(targetsBody),
  async (c) => {
    const targets = c.req.valid("json");
    const set = await c.var.data.reviewTargets.setRepo(c.req.param("id"), targets, new Date());
    if (!set) return apiError(c, "not_found");
    return c.json(viewOf(targets));
  },
);

reviewTargetsRoute.delete("/repos/:id", requireSession(["web"]), async (c) => {
  return c.json({ removed: await c.var.data.reviewTargets.clearRepo(c.req.param("id")) });
});
