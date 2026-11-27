import { type Context, Hono } from "hono";
import { spread } from "./cycles.js";
import { apiError, queryDays } from "./http.js";
import { repoName } from "./pull-ref.js";
import { requireSession } from "./session.js";
import {
  FLOW_SIZES,
  type FlowSize,
  type FlowSpread,
  type InsightsFlowView,
} from "./shared/index.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";

// The review flow on the Insights page: how the account's enrolled
// repositories' pull requests moved toward review, from what their
// webhooks recorded (src/auto-review/flows.ts, closes.ts). Nothing is read
// from the platforms.

export const flow = new Hono<AppEnv>();

const MAX_DAYS = 90;
const CAP = 5_000;
const WAITING = 5;
const REVIEWERS = 20;
const SIZE_LIMITS: [FlowSize, number][] = [
  ["xs", 10],
  ["s", 100],
  ["m", 500],
  ["l", 1000],
];

const sizeOf = (lines: number): FlowSize =>
  SIZE_LIMITS.find(([, under]) => lines < under)?.[0] ?? "xl";

const counted = (values: number[]): FlowSpread => ({ ...spread(values), count: values.length });

/** The Monday (UTC) that starts the week of t, as milliseconds. */
export function weekStart(t: number): number {
  const day = Math.floor(t / DAY) * DAY;
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
}

const between = (from: Date | null, to: Date | null, since: Date): number[] =>
  from && to && to >= since ? [Math.max(0, to.getTime() - from.getTime())] : [];

flow.get("/", requireSession(["web"]), async (c: Context<AppEnv>) => {
  const asked = c.req.query("repo");
  const repo = asked === undefined ? null : repoName.safeParse(asked);
  if (repo && !repo.success) return apiError(c, "not_found");
  const days = queryDays(c, 30, MAX_DAYS);
  const now = Date.now();
  const since = new Date(now - days * DAY);
  const data = c.var.data;
  let repoIds: string[] | null = null;
  if (repo?.success) {
    repoIds = (await data.find("reviewRepos", { fullName: repo.data }, 10)).map((r) => r.id);
    if (repoIds.length === 0) return apiError(c, "not_found");
  }
  const f = data.pullFlows;
  const [flows, merged, waiting, reviewers] = await Promise.all([
    f.flowsSince(since, repoIds, CAP),
    f.mergedSince(since, repoIds, CAP),
    f.waiting(repoIds, WAITING),
    f.reviewersSince(since, repoIds, REVIEWERS),
  ]);

  const weeks = new Map<number, { opened: number; merged: number }>();
  for (let w = weekStart(since.getTime()); w <= now; w += 7 * DAY) {
    weeks.set(w, { opened: 0, merged: 0 });
  }
  const week = (t: Date) => weeks.get(weekStart(t.getTime()));
  const sizes = Object.fromEntries([...FLOW_SIZES, "unknown"].map((s) => [s, 0])) as Record<
    FlowSize | "unknown",
    number
  >;
  for (const p of flows) {
    if (!p.openedAt || p.openedAt < since) continue;
    const w = week(p.openedAt);
    if (w) w.opened++;
    sizes[p.size === null ? "unknown" : sizeOf(p.size)]++;
  }
  for (const m of merged) {
    const w = week(m.closedAt);
    if (w) w.merged++;
  }
  const ready = (p: (typeof flows)[number]) => p.readyAt ?? p.openedAt;

  return c.json({
    repo: repo?.success ? repo.data : null,
    days,
    weeks: [...weeks].map(([start, n]) => ({
      start: new Date(start).toISOString().slice(0, 10),
      ...n,
    })),
    toFirstReview: counted(flows.flatMap((p) => between(ready(p), p.firstReviewAt, since))),
    toFirstApproval: counted(flows.flatMap((p) => between(ready(p), p.firstApprovalAt, since))),
    approvalToMerge: counted(merged.flatMap((m) => between(m.firstApprovalAt, m.closedAt, since))),
    waiting: waiting.map((p) => ({
      repo: p.repo,
      number: p.number,
      title: p.title,
      author: p.author,
      waitingMs: Math.max(0, now - p.since),
      reviewRequested: p.requestedAt !== null,
    })),
    reviewers: reviewers.map((r) => ({
      login: r.login,
      reviews: r.reviews,
      approvals: r.approvals,
      pulls: r.pulls,
    })),
    sizes,
    capped: flows.length >= CAP || merged.length >= CAP,
  } satisfies InsightsFlowView);
});
