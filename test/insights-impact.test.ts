import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spread } from "../src/cycles.js";
import { accounts, findings, reviews } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { parseFindings } from "../src/findings.js";
import { reviewRow } from "../src/reviews.js";
import type { ImpactCounts, InsightsImpactView } from "../src/shared/index.js";
import { DAY, HOUR } from "../src/time.js";
import { finding, upload } from "./finding-uploads.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// "What ocra changed" on the Insights page, from fixed stored rows: of the
// pull requests the webhooks recorded, those ocra reviewed; what its reviews
// found and what became of it; and how soon reviewed and unreviewed pull
// requests merged. Another account's rows never count.

beforeEach(resetDb);
afterEach(() => vi.useRealTimers());

// A Wednesday: the 7-day window starts at noon on Wednesday 11 November, in the week of Monday 9 November.
const now = new Date(Date.UTC(2026, 10, 18, 12));
const since = now.getTime() - 7 * DAY;
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
const HEAD = "a".repeat(40);

async function account(githubId: number, login: string, sharing: boolean) {
  const me = await signIn(githubId, login);
  await db.update(accounts).set({ shareFindings: sharing }).where(eq(accounts.id, me.account.id));
  const data = scoped(db, me.account.id);
  for (const [i, name] of ["api", "web"].entries()) {
    await data.insert("reviewRepos", {
      id: `${login}-${name}`,
      platform: "github",
      host: "github.com",
      platformRepoId: String(githubId * 10 + i),
      fullName: `${login}/${name}`,
    });
  }
  return { me, data, login };
}

type Account = Awaited<ReturnType<typeof account>>;

const opened = (a: Account, repo: string, number: number, at: Date) =>
  a.data.pullFlows.record({
    reviewRepoId: `${a.login}-${repo}`,
    number,
    title: `Pull ${number}`,
    author: "someone",
    draft: false,
    size: 3,
    openedAt: at,
    readyAt: at,
    seenAt: at,
  });

const closed = (a: Account, repo: string, number: number, open: Date, at: Date, merged = true) =>
  a.data.closedPulls.record({
    reviewRepoId: `${a.login}-${repo}`,
    number,
    title: `Pull ${number}`,
    merged,
    openedAt: open,
    closedAt: at,
  });

type Counts = { critical?: number; warning?: number; suggestion?: number };

/** An uploaded review of a pull request (or of none), made at `at`; its id and its findings' ids. */
async function reviewed(
  a: Account,
  run: string,
  pull: { repository: string; number: number } | null,
  at: Date,
  counts: Counts,
  outcomes = { fixed: 0, dismissed: 0 },
  shared: Record<string, unknown>[] = [],
) {
  const { reviewersDropped: _, ...row } = reviewRow(
    reviewUploadSchema.parse({
      ...upload(run, []),
      findings: { critical: 0, warning: 0, suggestion: 0, ...counts },
      outcomes,
      ...(pull ? { pullRequest: { ...pull, headSha: HEAD } } : {}),
    }),
  );
  const rows = parseFindings(shared).rows;
  const stored = await a.data.insertReview(row, rows, { dailyUploads: 50, maxFindings: 50 });
  if (stored.outcome !== "stored") throw new Error(stored.outcome);
  await db.update(reviews).set({ createdAt: at }).where(eq(reviews.id, stored.id));
  const found = await a.data.findingsOf(stored.id);
  return { id: stored.id, findings: found.map((f) => f.id) };
}

const pr = (a: Account, repo: string, number: number) => ({
  repository: `https://github.com/${a.login}/${repo}`,
  number,
});

async function fixture(a: Account) {
  // 1: opened this week, reviewed an hour later with three shared findings, merged.
  await opened(a, "api", 1, ago(30));
  await closed(a, "api", 1, ago(30), ago(5));
  const first = await reviewed(
    a,
    "run-a",
    pr(a, "api", 1),
    ago(29),
    { critical: 1, warning: 2 },
    undefined,
    [
      finding({ fingerprint: "fp-1", severity: "critical" }),
      finding({ fingerprint: "fp-2", severity: "warning" }),
      finding({ fingerprint: "fp-3", severity: "warning" }),
    ],
  );
  const [fixedId, dismissedId, openId] = first.findings;
  if (!fixedId || !dismissedId || !openId) throw new Error("the findings were not kept");
  await a.data.decide([fixedId], { status: "fixed", reason: null, note: null, decidedAt: now });
  await a.data.decide([dismissedId], {
    status: "dismissed",
    reason: "false_positive",
    note: null,
    decidedAt: now,
  });
  await a.data.insert("findingIssues", {
    findingId: openId,
    reviewId: first.id,
    number: 12,
    url: "https://github.com/x/issues/12",
    claimedAt: now,
  });
  // A claim still in flight is not an issue opened.
  await a.data.insert("findingIssues", {
    findingId: dismissedId,
    reviewId: first.id,
    number: null,
    url: null,
    claimedAt: now,
  });
  // 2: opened last week, never reviewed, merged.
  await opened(a, "api", 2, ago(100));
  await closed(a, "api", 2, ago(100), ago(50));
  // 3: opened before the window and first reviewed then; re-reviewed in it, merged.
  await opened(a, "api", 3, ago(240));
  await reviewed(a, "run-d", pr(a, "api", 3), ago(216), { critical: 5 });
  await reviewed(a, "run-b", pr(a, "api", 3), ago(72), { warning: 1 }, { fixed: 2, dismissed: 1 });
  await closed(a, "api", 3, ago(240), ago(1));
  // 4: web, opened this week and reviewed, still open.
  await opened(a, "web", 4, ago(20));
  await reviewed(a, "run-c", pr(a, "web", 4), ago(19), { suggestion: 3 });
  // 5 opened a millisecond before the window, 6 at its start.
  await opened(a, "web", 5, new Date(since - 1));
  await opened(a, "web", 6, new Date(since));
  // Merged before the window, and closed unmerged in it: neither is a merge counted.
  await closed(a, "api", 7, ago(300), ago(8 * 24));
  await closed(a, "api", 8, ago(30), ago(2), false);
  // A local review and a review of a repository not enrolled.
  await reviewed(a, "run-local", null, ago(2), { critical: 9 });
  await reviewed(a, "run-other", { repository: "https://github.com/other/x", number: 1 }, ago(2), {
    critical: 9,
  });
}

const view = async (auth: Record<string, string>, query = "days=7") => {
  const res = await call(`/api/insights/impact?${query}`, { auth });
  return { status: res.status, body: (await res.json()) as InsightsImpactView };
};

type ActedOn = NonNullable<ImpactCounts["actedOn"]>;
const acted = (
  over: Partial<Omit<ActedOn, "fixedVia">>,
  via: Partial<ActedOn["fixedVia"]> = {},
): ActedOn => ({
  fixed: 0,
  fixedVia: { applied: 0, suggestion: 0, manual: 0, rereview: 0, unknown: 0, ...via },
  dismissed: 0,
  open: 0,
  issueOpened: 0,
  threadResolved: 0,
  ...over,
});

const counts = (over: Partial<ImpactCounts>, sharing = true): ImpactCounts => ({
  pulls: 0,
  reviewedPulls: 0,
  reviews: 0,
  findings: { critical: 0, warning: 0, suggestion: 0 },
  fixedOnRereview: 0,
  dismissedOnRereview: 0,
  actedOn: sharing ? acted({}) : null,
  ...over,
});

const spreadOf = (values: number[]) => ({ ...spread(values), count: values.length });

describe("what ocra changed", () => {
  it("counts each metric from the stored rows, per week and per repository", async () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const a = await account(42, "mona", true);
    await fixture(a);
    const { status, body } = await view(a.me.auth);
    expect(status).toBe(200);
    const actedOn = acted({ fixed: 1, dismissed: 1, open: 1, issueOpened: 1 }, { manual: 1 });
    expect(body.repo).toBeNull();
    expect(body.days).toBe(7);
    expect(body.sharesFindings).toBe(true);
    expect(body.total).toEqual(
      counts({
        pulls: 4,
        reviewedPulls: 2,
        reviews: 3,
        findings: { critical: 1, warning: 3, suggestion: 3 },
        fixedOnRereview: 2,
        dismissedOnRereview: 1,
        actedOn,
      }),
    );
    expect(body.weeks).toEqual([
      {
        start: "2026-11-09",
        ...counts({
          pulls: 2,
          reviews: 1,
          findings: { critical: 0, warning: 1, suggestion: 0 },
          fixedOnRereview: 2,
          dismissedOnRereview: 1,
        }),
      },
      {
        start: "2026-11-16",
        ...counts({
          pulls: 2,
          reviewedPulls: 2,
          reviews: 2,
          findings: { critical: 1, warning: 2, suggestion: 3 },
          actedOn,
        }),
      },
    ]);
    expect(body.repos).toEqual([
      {
        repo: "mona/api",
        ...counts({
          pulls: 2,
          reviewedPulls: 1,
          reviews: 2,
          findings: { critical: 1, warning: 3, suggestion: 0 },
          fixedOnRereview: 2,
          dismissedOnRereview: 1,
          actedOn,
        }),
      },
      {
        repo: "mona/web",
        ...counts({
          pulls: 2,
          reviewedPulls: 1,
          reviews: 1,
          findings: { critical: 0, warning: 0, suggestion: 3 },
        }),
      },
    ]);
    expect(body.toMerge).toEqual({
      fromReview: spreadOf([24 * HOUR, 215 * HOUR]),
      reviewed: spreadOf([25 * HOUR, 239 * HOUR]),
      unreviewed: spreadOf([50 * HOUR]),
    });
    expect(body.capped).toBe(false);
  });

  it("counts no finding's fate while the account does not share findings", async () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const a = await account(42, "mona", false);
    await opened(a, "api", 1, ago(30));
    await reviewed(a, "run-a", pr(a, "api", 1), ago(29), { critical: 1, warning: 2 }, undefined, [
      finding({ fingerprint: "fp-1" }),
    ]);
    const { body } = await view(a.me.auth);
    expect(body.sharesFindings).toBe(false);
    expect(body.total).toEqual(
      counts(
        {
          pulls: 1,
          reviewedPulls: 1,
          reviews: 1,
          findings: { critical: 1, warning: 2, suggestion: 0 },
        },
        false,
      ),
    );
    expect(JSON.stringify(body)).not.toContain("SQL built from input");
  });

  it("answers zeros for an account with nothing stored", async () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const me = await signIn(7, "empty");
    const { status, body } = await view(me.auth, "days=30");
    expect(status).toBe(200);
    expect(body.total).toEqual(counts({}, false));
    expect(body.repos).toEqual([]);
    expect(body.weeks).toHaveLength(5);
    expect(body.weeks.every((w) => w.pulls === 0 && w.reviews === 0)).toBe(true);
    const none = spreadOf([]);
    expect(body.toMerge).toEqual({ fromReview: none, reviewed: none, unreviewed: none });
  });

  it("reads one enrolled repository when asked, and refuses one not enrolled", async () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const a = await account(42, "mona", true);
    await fixture(a);
    const { body } = await view(a.me.auth, "days=7&repo=mona/web");
    expect(body.repo).toBe("mona/web");
    expect(body.total).toEqual(
      counts({
        pulls: 2,
        reviewedPulls: 1,
        reviews: 1,
        findings: { critical: 0, warning: 0, suggestion: 3 },
      }),
    );
    expect(body.repos.map((r) => r.repo)).toEqual(["mona/web"]);
    expect(body.toMerge.fromReview.count + body.toMerge.unreviewed.count).toBe(0);
    expect((await view(a.me.auth, "days=7&repo=other/x")).status).toBe(404);
    expect((await view(a.me.auth, "days=7&repo=..")).status).toBe(404);
  });

  it("never counts another account's reviews, findings or pull requests", async () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const mona = await account(42, "mona", true);
    const bob = await account(43, "bob", true);
    await fixture(mona);
    // Bob's own review names mona's pull request: it is still not mona's.
    await reviewed(bob, "run-bob", pr(mona, "api", 2), ago(3), { critical: 4 }, undefined, [
      finding({ fingerprint: "fp-bob" }),
    ]);
    const { body } = await view(mona.me.auth);
    expect(body.total.reviews).toBe(3);
    expect(body.total.reviewedPulls).toBe(2);
    expect(body.total.findings.critical).toBe(1);
    expect(body.toMerge.unreviewed.count).toBe(1);
    const other = await view(bob.me.auth);
    expect(other.body.total).toEqual(counts({}));
    expect(other.body.repos).toEqual([]);
  });

  it("counts fixed findings by how they became fixed, once each, and older ones as unknown", async () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const mona = await account(42, "mona", true);
    const bob = await account(43, "bob", true);
    await opened(mona, "api", 1, ago(30));
    const fps = ["applied", "suggestion", "manual", "older", "rereview", "open"].map((_, i) =>
      `${i}`.repeat(16),
    );
    const { findings: ids } = await reviewed(
      mona,
      "run-a",
      pr(mona, "api", 1),
      ago(29),
      {},
      undefined,
      fps.map((fingerprint) => finding({ fingerprint })),
    );
    const [applied, suggested, manual, older, rereview, open] = ids;
    if (!applied || !suggested || !manual || !older || !rereview || !open)
      throw new Error("not kept");
    const onPull = (fingerprints: string[]) => ({
      identity: `https://github.com/mona/api`,
      number: 1,
      fingerprints,
    });
    const byHand = { status: "fixed" as const, reason: null, note: null, decidedAt: now };
    const m = mona.data.findingOutcomes;
    // Another account's writes reach none of mona's findings.
    expect(await bob.data.findingOutcomes.markFixed([applied], "applied")).toBe(0);
    expect(
      await bob.data.findingOutcomes.markFixedOnPull(onPull([fps[1] ?? ""]), "suggestion"),
    ).toBe(0);
    expect(await bob.data.findingOutcomes.markThreadResolved(onPull([fps[5] ?? ""]), true)).toBe(0);
    expect(await m.markFixed([applied], "applied")).toBe(1);
    expect(await m.markFixedOnPull(onPull([fps[1] ?? ""]), "suggestion")).toBe(1);
    await mona.data.decide([manual], byHand);
    // A second path finds each one fixed already and records nothing.
    expect(await m.markFixed([applied, suggested, manual], "applied")).toBe(0);
    expect(await m.markFixedOnPull(onPull([fps[0] ?? "", fps[2] ?? ""]), "suggestion")).toBe(0);
    await mona.data.decide([applied], byHand);
    // One fixed before the source was kept, and one the CLI's re-review fixed.
    await db.update(findings).set({ status: "fixed" }).where(eq(findings.id, older));
    await db
      .update(findings)
      .set({ status: "fixed", fixedVia: "rereview" })
      .where(eq(findings.id, rereview));
    expect(await m.markThreadResolved(onPull([fps[5] ?? ""]), true)).toBe(1);
    const { body } = await view(mona.me.auth);
    expect(body.total.actedOn).toEqual(
      acted(
        { fixed: 5, open: 1, threadResolved: 1 },
        { applied: 1, suggestion: 1, manual: 1, rereview: 1, unknown: 1 },
      ),
    );
    expect((await view(bob.me.auth)).body.total.actedOn).toEqual(acted({}));
    // Reopening clears how it was fixed.
    await mona.data.decide([applied], {
      status: "open",
      reason: null,
      note: null,
      decidedAt: null,
    });
    expect((await mona.data.get("findings", applied))?.fixedVia).toBeNull();
  });

  it("asks for a web session", async () => {
    const res = await call("/api/insights/impact");
    expect(res.status).toBe(401);
  });
});
