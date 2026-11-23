import { type Context, Hono } from "hono";
import { repoName, spread } from "./cycles.js";
import { keepsFindings } from "./findings-kept.js";
import { weekStart } from "./flow.js";
import { apiError, queryDays } from "./http.js";
import { repoIdentity } from "./platforms/platform.js";
import { platformsOf } from "./platforms/registry.js";
import { requireSession } from "./session.js";
import type { FlowSpread, ImpactCounts, InsightsImpactView } from "./shared/index.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";

// What ocra changed on the Insights page: in every repository the account
// reviewed pull requests of, what its reviews found and what became of it;
// of the enrolled repositories' pull requests the webhooks recorded, how
// many ocra reviewed and how soon reviewed and unreviewed ones merged. A
// repository not enrolled has no such records: its pull requests are the
// ones reviewed, and its merges are not timed. Only stored rows are read
// (src/db/impact.ts); a finding's fate is counted only while the account
// shares findings, and never its text.

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

/** A repository's name from its identity, `https://host/owner/name`: owner/name. */
function nameFromIdentity(identity: string): string {
  try {
    return new URL(identity).pathname.slice(1);
  } catch {
    return identity;
  }
}

impact.get("/", requireSession(["web"]), async (c: Context<AppEnv>) => {
  const asked = c.req.query("repo");
  const repo = asked === undefined ? null : repoName.safeParse(asked);
  if (repo && !repo.success) return apiError(c, "not_found");
  const days = queryDays(c, 30, MAX_DAYS);
  const now = Date.now();
  const since = new Date(now - days * DAY);
  const sharing = await keepsFindings(c);
  const data = c.var.data;
  const q = data.impact;
  const [enrolled, reviewedRepos] = await Promise.all([
    data.find("reviewRepos", repo?.success ? { fullName: repo.data } : {}, MAX_REPOS),
    repo?.success ? q.reposSince(since, CAP) : [],
  ]);

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
  const isEnrolled = new Set(nameOf.keys());
  let identities: string[] | null = null;
  if (repo?.success) {
    const wanted = repo.data.toLowerCase();
    const others = reviewedRepos
      .map((r) => r.identity)
      .filter((i) => !isEnrolled.has(i) && nameFromIdentity(i) === wanted);
    identities = [...isEnrolled, ...others];
    if (identities.length === 0 && enrolled.length === 0) return apiError(c, "not_found");
  }
  const named = (identity: string) => nameOf.get(identity) ?? nameFromIdentity(identity);
  const repoIds = repo?.success ? enrolled.map((r) => r.id) : null;
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
    let perRepo = repos.get(identity);
    if (!perRepo) {
      perRepo = empty(sharing);
      repos.set(identity, perRepo);
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
  // Rows come newest first, so the last one seen of a pull request is its first review in the window.
  const firstInWindow = new Map<string, { identity: string; at: number }>();
  for (const r of reviewed) {
    if (!isEnrolled.has(r.repo) && r.number !== null) {
      firstInWindow.set(pullKey(r.repo, r.number), {
        identity: r.repo,
        at: r.createdAt.getTime(),
      });
    }
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
  for (const p of firstInWindow.values()) {
    for (const b of bucketsOf(p.identity, p.at)) {
      b.pulls++;
      b.reviewedPulls++;
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
      .map(([identity, n]) => ({ repo: named(identity), enrolled: isEnrolled.has(identity), ...n }))
      .sort((a, b) => b.reviews - a.reviews || b.pulls - a.pulls || (a.repo < b.repo ? -1 : 1)),
    toMerge:
      isEnrolled.size === 0
        ? null
        : {
            fromReview: counted(fromReview),
            reviewed: counted(reviewedToMerge),
            unreviewed: counted(unreviewedToMerge),
          },
    capped:
      reviewed.length >= CAP ||
      reviewedRepos.length >= CAP ||
      opened.length >= CAP ||
      merged.length >= CAP ||
      (decided?.statuses.length ?? 0) >= CAP ||
      (decided?.issues.length ?? 0) >= CAP,
  } satisfies InsightsImpactView);
});
