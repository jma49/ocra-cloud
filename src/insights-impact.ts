import { type Context, Hono } from "hono";
import { repoName, spread } from "./cycles.js";
import { weekStart } from "./flow.js";
import { apiError, queryDays } from "./http.js";
import { repoIdentity } from "./platforms/platform.js";
import { platformsOf } from "./platforms/registry.js";
import { requireSession } from "./session.js";
import type { FlowSpread, ImpactCounts, InsightsImpactView } from "./shared/index.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";

// What ocra changed on the Insights page: of the enrolled repositories' pull
// requests the webhooks recorded, how many ocra reviewed, what its reviews
// found and what became of it, and how soon reviewed and unreviewed pull
// requests merged. Only stored rows are read (src/db/impact.ts); a finding's
// fate is counted only while the account shares findings, and never its text.

export const impact = new Hono<AppEnv>();

const MAX_DAYS = 90;
const CAP = 5_000;
const MAX_REPOS = 100;
const WEEK = 7 * DAY;

const counted = (values: number[]): FlowSpread => ({ ...spread(values), count: values.length });

const empty = (sharing: boolean): ImpactCounts => ({
  pulls: 0,
  reviewedPulls: 0,
  reviews: 0,
  findings: { critical: 0, warning: 0, suggestion: 0 },
  fixedOnRereview: 0,
  dismissedOnRereview: 0,
  actedOn: sharing
    ? {
        fixed: 0,
        fixedVia: { applied: 0, suggestion: 0, manual: 0, rereview: 0, unknown: 0 },
        dismissed: 0,
        open: 0,
        issueOpened: 0,
        threadResolved: 0,
      }
    : null,
});

const pullKey = (identity: string, number: number) => `${identity}#${number}`;

impact.get("/", requireSession(["web"]), async (c: Context<AppEnv>) => {
  const asked = c.req.query("repo");
  const repo = asked === undefined ? null : repoName.safeParse(asked);
  if (repo && !repo.success) return apiError(c, "not_found");
  const days = queryDays(c, 30, MAX_DAYS);
  const now = Date.now();
  const since = new Date(now - days * DAY);
  const sharing = c.var.session.account.shareFindings;
  const data = c.var.data;
  const enrolled = await data.find(
    "reviewRepos",
    repo?.success ? { fullName: repo.data } : {},
    MAX_REPOS,
  );
  if (repo?.success && enrolled.length === 0) return apiError(c, "not_found");

  // A review names its pull request's repository as the CLI does: its identity on the platform.
  const platforms = platformsOf(c.env, c.req.url);
  const identityOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const r of enrolled) {
    const base =
      platforms.find((p) => p.kind === r.platform && p.host === r.host)?.url ?? `https://${r.host}`;
    try {
      const identity = repoIdentity({ url: base }, r.fullName).toLowerCase();
      identityOf.set(r.id, identity);
      nameOf.set(identity, r.fullName);
    } catch {}
  }
  const identities = [...nameOf.keys()];
  const repoIds = repo?.success ? enrolled.map((r) => r.id) : null;
  const q = data.impact;
  const [reviewed, opened, merged, decided] = await Promise.all([
    q.reviewsSince(since, identities, CAP),
    q.openedSince(since, repoIds, CAP),
    q.mergedSince(since, repoIds, CAP),
    sharing ? q.findingsSince(since, identities, CAP) : null,
  ]);
  const pulls = [...opened, ...merged].flatMap((p) => {
    const identity = identityOf.get(p.reviewRepoId);
    return identity ? [{ identity, number: p.number }] : [];
  });
  const unique = new Map(pulls.map((p) => [pullKey(p.identity, p.number), p]));
  const firstReview = new Map(
    (
      await q.firstReviews(
        [...unique.values()].map((p) => ({ repo: p.identity, number: p.number })),
      )
    ).map((f) => [pullKey(f.repo, f.number), f.at]),
  );

  const total = empty(sharing);
  const weeks = new Map<number, ImpactCounts>();
  for (let w = weekStart(since.getTime()); w <= now; w += WEEK) weeks.set(w, empty(sharing));
  const repos = new Map<string, ImpactCounts>();
  const bucketsOf = (identity: string, at: number): ImpactCounts[] => {
    const name = nameOf.get(identity);
    if (name === undefined) return [];
    let perRepo = repos.get(name);
    if (!perRepo) {
      perRepo = empty(sharing);
      repos.set(name, perRepo);
    }
    const week = weeks.get(weekStart(at));
    return week ? [total, week, perRepo] : [total, perRepo];
  };

  for (const p of opened) {
    const identity = identityOf.get(p.reviewRepoId);
    if (!identity || !p.openedAt) continue;
    const isReviewed = firstReview.has(pullKey(identity, p.number));
    for (const b of bucketsOf(identity, p.openedAt.getTime())) {
      b.pulls++;
      if (isReviewed) b.reviewedPulls++;
    }
  }
  const reviewBuckets = new Map<string, ImpactCounts[]>();
  for (const r of reviewed) {
    const buckets = bucketsOf(r.repo, r.createdAt.getTime());
    reviewBuckets.set(r.id, buckets);
    for (const b of buckets) {
      b.reviews++;
      b.findings.critical += r.critical;
      b.findings.warning += r.warning;
      b.findings.suggestion += r.suggestion;
      b.fixedOnRereview += r.fixed;
      b.dismissedOnRereview += r.dismissed;
    }
  }
  for (const s of decided?.statuses ?? []) {
    for (const b of reviewBuckets.get(s.reviewId) ?? []) {
      if (!b.actedOn) continue;
      b.actedOn[s.status] += s.n;
      b.actedOn.threadResolved += s.threadResolved;
      if (s.status === "fixed") b.actedOn.fixedVia[s.fixedVia ?? "unknown"] += s.n;
    }
  }
  for (const i of decided?.issues ?? []) {
    for (const b of reviewBuckets.get(i.reviewId) ?? []) {
      if (b.actedOn) b.actedOn.issueOpened += i.n;
    }
  }

  const fromReview: number[] = [];
  const reviewedToMerge: number[] = [];
  const unreviewedToMerge: number[] = [];
  for (const m of merged) {
    const identity = identityOf.get(m.reviewRepoId);
    if (!identity) continue;
    const closed = m.closedAt.getTime();
    const first = firstReview.get(pullKey(identity, m.number));
    const before = first !== undefined && first <= closed;
    if (before) fromReview.push(closed - first);
    if (m.openedAt === null) continue;
    (before ? reviewedToMerge : unreviewedToMerge).push(Math.max(0, closed - Number(m.openedAt)));
  }

  return c.json({
    repo: repo?.success ? repo.data : null,
    days,
    sharesFindings: sharing,
    total,
    weeks: [...weeks].map(([start, n]) => ({
      start: new Date(start).toISOString().slice(0, 10),
      ...n,
    })),
    repos: [...repos]
      .map(([name, n]) => ({ repo: name, ...n }))
      .sort((a, b) => b.reviews - a.reviews || b.pulls - a.pulls || (a.repo < b.repo ? -1 : 1)),
    toMerge: {
      fromReview: counted(fromReview),
      reviewed: counted(reviewedToMerge),
      unreviewed: counted(unreviewedToMerge),
    },
    capped:
      reviewed.length >= CAP ||
      opened.length >= CAP ||
      merged.length >= CAP ||
      (decided?.statuses.length ?? 0) >= CAP ||
      (decided?.issues.length ?? 0) >= CAP,
  } satisfies InsightsImpactView);
});
