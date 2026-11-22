import { type Context, Hono } from "hono";
import { repoName, spread } from "./cycles.js";
import { weekStart } from "./flow.js";
import { apiError, queryDays } from "./http.js";
import { requireSession } from "./session.js";
import type { FlowSpread, ReviewerLoad, ReviewLoadView, ReviewLoadWeek } from "./shared/index.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";

// Reviewer workload on the Insights page: per platform login, the reviews
// given, how soon an ask was answered, the asks open now and the pull
// requests authored, and per week the team's turnaround and the pull
// requests left waiting a day. Only what the enrolled repositories'
// webhooks recorded is read (src/db/review-load.ts); nothing from the platforms.

export const reviewLoad = new Hono<AppEnv>();

const MAX_DAYS = 90;
const CAP = 5_000;
const PEOPLE = 100;
const GROUPS = 500;
const WEEK = 7 * DAY;

const counted = (values: number[]): FlowSpread => ({ ...spread(values), count: values.length });

type Ask = { login: string; reviewRepoId: string; number: number; requestedAt: Date };
type Review = { login: string; reviewRepoId: string; number: number; submittedAt: Date };

/** Each ask's first review by the one asked, at or after the ask: [ask, reviewed at]. */
function answered(asks: readonly Ask[], reviews: readonly Review[]): [Ask, number][] {
  const byPull = new Map<string, number[]>();
  for (const r of reviews) {
    const key = `${r.reviewRepoId}\n${r.number}\n${r.login}`;
    const list = byPull.get(key) ?? [];
    list.push(r.submittedAt.getTime());
    byPull.set(key, list);
  }
  return asks.flatMap((a): [Ask, number][] => {
    const asked = a.requestedAt.getTime();
    const times = byPull.get(`${a.reviewRepoId}\n${a.number}\n${a.login}`) ?? [];
    const first = Math.min(...times.filter((t) => t >= asked));
    return Number.isFinite(first) ? [[a, first]] : [];
  });
}

type Wait = {
  readyAt: number | null;
  firstReviewAt: Date | null;
  draft: boolean;
  reopenedAt: Date | null;
  closedAt: Date | null;
};

/** When a pull request had waited a day without a first review, and when that ended, or null. */
export function overDay(w: Wait, now: number): [number, number] | null {
  if (w.readyAt === null || (w.draft && !w.firstReviewAt)) return null;
  const closed =
    w.closedAt && (!w.reopenedAt || w.closedAt >= w.reopenedAt) ? w.closedAt.getTime() : now;
  const end = Math.min(w.firstReviewAt?.getTime() ?? now, closed, now);
  const from = w.readyAt + DAY;
  return from < end ? [from, end] : null;
}

reviewLoad.get("/", requireSession(["web"]), async (c: Context<AppEnv>) => {
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
  const l = data.reviewLoad;
  const [given, asks, reviews, open, authored, waits] = await Promise.all([
    data.pullFlows.reviewersSince(since, repoIds, GROUPS),
    l.asksSince(since, repoIds, CAP),
    l.reviewsSince(since, repoIds, CAP),
    l.openAsks(repoIds, GROUPS),
    l.authoredSince(since, repoIds, GROUPS),
    l.waitsSince(since, repoIds, CAP),
  ]);

  const people = new Map<string, ReviewerLoad & { times: number[] }>();
  const person = (login: string) => {
    let p = people.get(login);
    if (!p) {
      p = {
        login,
        reviews: 0,
        asked: 0,
        toFirstReview: counted([]),
        openRequests: 0,
        authored: 0,
        times: [],
      };
      people.set(login, p);
    }
    return p;
  };
  for (const g of given) person(g.login).reviews = g.reviews;
  for (const a of asks) person(a.login).asked++;
  for (const o of open) person(o.login).openRequests = o.open;
  for (const a of authored) person(a.login).authored = a.authored;

  const weeks = new Map<number, { times: number[]; waiting: number }>();
  for (let w = weekStart(since.getTime()); w <= now; w += WEEK)
    weeks.set(w, { times: [], waiting: 0 });
  for (const [a, at] of answered(asks, reviews)) {
    const ms = at - a.requestedAt.getTime();
    person(a.login).times.push(ms);
    weeks.get(weekStart(at))?.times.push(ms);
  }
  for (const w of waits) {
    const span = overDay(w, now);
    if (!span) continue;
    for (const [start, week] of weeks) {
      if (span[0] < Math.min(start + WEEK, now) && span[1] > Math.max(start, since.getTime()))
        week.waiting++;
    }
  }

  const reviewers = [...people.values()]
    .sort(
      (a, b) =>
        b.reviews - a.reviews ||
        b.openRequests - a.openRequests ||
        (a.login < b.login ? -1 : a.login > b.login ? 1 : 0),
    )
    .slice(0, PEOPLE)
    .map((p) => ({
      login: p.login,
      reviews: p.reviews,
      asked: p.asked,
      toFirstReview: counted(p.times),
      openRequests: p.openRequests,
      authored: p.authored,
    }));

  return c.json({
    repo: repo?.success ? repo.data : null,
    days,
    reviewers,
    weeks: [...weeks].map(
      ([start, w]): ReviewLoadWeek => ({
        start: new Date(start).toISOString().slice(0, 10),
        turnaround: counted(w.times),
        waitingOver24h: w.waiting,
      }),
    ),
    capped: asks.length >= CAP || reviews.length >= CAP || waits.length >= CAP,
  } satisfies ReviewLoadView);
});
