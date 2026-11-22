import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordGithubRequest, recordGitlabRequests } from "../src/auto-review/requests.js";
import { scoped } from "../src/db/scoped.js";
import { overDay } from "../src/review-load.js";
import type { ReviewLoadView } from "../src/shared/index.js";
import { DAY, HOUR } from "../src/time.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// Reviewer workload on the Insights page, from fixed webhook records: per
// login the reviews given, ask to first review, asks open now and pull
// requests authored; per week the turnaround and the pull requests that
// waited past a day. Another account sees none of it.

beforeEach(resetDb);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A Wednesday: the 7-day window starts in the week of Monday 9 November.
const now = new Date(Date.UTC(2026, 10, 18, 12));
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
const ALICE = { id: 100, login: "alice" };
const BOB = { id: 101, login: "bob" };
const CAROL = { id: 102, login: "carol" };

async function account(githubId: number, login: string) {
  const me = await signIn(githubId, login);
  const data = scoped(db, me.account.id);
  await data.insert("reviewRepos", {
    id: `repo-${githubId}`,
    platform: "github",
    host: "github.com",
    platformRepoId: String(githubId),
    fullName: `${login}/api`,
  });
  return { me, data, repo: `repo-${githubId}`, platformRepo: githubId };
}

type Account = Awaited<ReturnType<typeof account>>;

const pull = (a: Account, number: number, author: string, opened: number, extra: object = {}) =>
  a.data.pullFlows.record({
    reviewRepoId: a.repo,
    number,
    title: `Pull ${number}`,
    author,
    draft: false,
    size: 3,
    openedAt: ago(opened),
    readyAt: ago(opened),
    seenAt: ago(opened),
    ...extra,
  });

const ask = (a: Account, number: number, reviewer: { id: number; login?: string }, hours: number) =>
  recordGithubRequest(db, "github.com", "pull_request", {
    action: "review_requested",
    number,
    pull_request: { updated_at: ago(hours).toISOString() },
    requested_reviewer: reviewer,
    repository: { id: a.platformRepo },
  });

async function review(a: Account, number: number, reviewer: typeof ALICE, hours: number) {
  await a.data.pullFlows.review(
    {
      reviewRepoId: a.repo,
      number,
      title: `Pull ${number}`,
      author: null,
      draft: false,
      size: null,
      seenAt: ago(hours),
    },
    {
      reviewKey: `${number}:${reviewer.login}:${hours}`,
      reviewer: reviewer.login,
      approved: false,
      submittedAt: ago(hours),
    },
  );
  await recordGithubRequest(db, "github.com", "pull_request_review", {
    action: "submitted",
    review: { user: reviewer, submitted_at: ago(hours).toISOString() },
    pull_request: { number },
    repository: { id: a.platformRepo },
  });
}

async function fixture(a: Account) {
  // 5: alice answers after 2 hours; bob never does, and it is still open.
  await pull(a, 5, "mona", 48);
  await ask(a, 5, ALICE, 40);
  await ask(a, 5, BOB, 40);
  await review(a, 5, ALICE, 38);
  // 6: alice reviewed before she was asked; the ask is answered after 4 hours.
  await pull(a, 6, "mona", 30);
  await review(a, 6, ALICE, 25);
  await ask(a, 6, ALICE, 20);
  await review(a, 6, ALICE, 16);
  // 7: alice's, waiting for bob.
  await pull(a, 7, "alice", 10);
  await ask(a, 7, BOB, 9);
  // 8: bob's draft: alice's ask of it is not open.
  await pull(a, 8, "bob", 6, { draft: true, readyAt: null });
  await ask(a, 8, ALICE, 5);
  // 9: bob's, closed after waiting 50 hours unreviewed: past a day in both weeks.
  await pull(a, 9, "bob", 100);
  await ask(a, 9, CAROL, 99);
  await a.data.closedPulls.record({
    reviewRepoId: a.repo,
    number: 9,
    title: "Pull 9",
    merged: false,
    openedAt: ago(100),
    closedAt: ago(50),
  });
  // 10: carol's, unreviewed for 60 hours and open.
  await pull(a, 10, "carol", 60);
  // An ask whose event named no login is left out.
  await ask(a, 10, { id: 103 }, 30);
}

const view = async (auth: Record<string, string>, query = "days=7") => {
  const res = await call(`/api/insights/reviewers?${query}`, { auth });
  return { status: res.status, body: (await res.json()) as ReviewLoadView };
};

describe("reviewer workload", () => {
  it("answers per reviewer and per week from the stored records", async () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const a = await account(42, "mona");
    await fixture(a);
    const { status, body } = await view(a.me.auth);
    expect(status).toBe(200);
    const none = { median: null, p90: null, count: 0 };
    expect(body.reviewers).toEqual([
      {
        login: "alice",
        reviews: 3,
        asked: 3,
        toFirstReview: { median: 2 * HOUR, p90: 4 * HOUR, count: 2 },
        openRequests: 0,
        authored: 1,
      },
      { login: "bob", reviews: 0, asked: 2, toFirstReview: none, openRequests: 2, authored: 2 },
      { login: "carol", reviews: 0, asked: 1, toFirstReview: none, openRequests: 0, authored: 1 },
      { login: "mona", reviews: 0, asked: 0, toFirstReview: none, openRequests: 0, authored: 2 },
    ]);
    expect(body.weeks).toEqual([
      { start: "2026-11-09", turnaround: none, waitingOver24h: 1 },
      {
        start: "2026-11-16",
        turnaround: { median: 2 * HOUR, p90: 4 * HOUR, count: 2 },
        waitingOver24h: 2,
      },
    ]);
    expect([body.repo, body.days, body.capped]).toEqual([null, 7, false]);

    const one = await view(a.me.auth, "days=7&repo=mona/api");
    expect([one.body.repo, one.body.reviewers.length]).toEqual(["mona/api", 4]);
    // A shorter window: only what happened in the last day.
    const day = await view(a.me.auth, "days=1");
    expect(day.body.reviewers.map((r) => [r.login, r.reviews, r.asked, r.openRequests])).toEqual([
      ["alice", 1, 2, 0],
      ["bob", 0, 1, 2],
    ]);
  });

  it("shows another account none of it, and finds no repository it did not enroll", async () => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const a = await account(42, "mona");
    await fixture(a);
    const other = await account(43, "hubot");
    const theirs = await view(other.me.auth);
    expect(theirs.body.reviewers).toEqual([]);
    expect(theirs.body.weeks.map((w) => [w.turnaround.count, w.waitingOver24h])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect((await view(other.me.auth, "repo=mona/api")).status).toBe(404);
    expect((await view(other.me.auth, "repo=..%2Fx")).status).toBe(404);
  });

  it("keeps a GitLab reviewer's username from the merge request hook", async () => {
    const me = await signIn(42, "mona");
    const data = scoped(db, me.account.id);
    await data.insert("reviewRepos", {
      id: "lab",
      platform: "gitlab",
      host: "gitlab.example.com",
      platformRepoId: "77",
      fullName: "team/web",
    });
    const repo = { id: "lab", accountId: me.account.id };
    await recordGitlabRequests(db, repo, {
      object_attributes: { iid: 3, action: "open", reviewer_ids: [900, 901] },
      reviewers: [{ id: 900, username: "dana" }],
    });
    const rows = await data.find("reviewRequests", { reviewRepoId: "lab" }, 10);
    expect(rows.map((r) => [r.reviewerId, r.reviewer]).sort()).toEqual([
      ["900", "dana"],
      ["901", null],
    ]);
  });
});

describe("a day past ready without a first review", () => {
  const base = { firstReviewAt: null, draft: false, reopenedAt: null, closedAt: null };
  it("starts a day after ready and ends at the first review, the close or now", () => {
    const t = now.getTime();
    expect(overDay({ ...base, readyAt: t - 3 * DAY }, t)).toEqual([t - 2 * DAY, t]);
    expect(overDay({ ...base, readyAt: t - 3 * DAY, firstReviewAt: new Date(t - DAY) }, t)).toEqual(
      [t - 2 * DAY, t - DAY],
    );
    expect(overDay({ ...base, readyAt: t - 3 * DAY, closedAt: new Date(t - DAY) }, t)).toEqual([
      t - 2 * DAY,
      t - DAY,
    ]);
    // Reopened after the close: open again.
    expect(
      overDay(
        { ...base, readyAt: t - 3 * DAY, closedAt: new Date(t - DAY), reopenedAt: new Date(t - 1) },
        t,
      ),
    ).toEqual([t - 2 * DAY, t]);
    expect(
      overDay({ ...base, readyAt: t - 3 * DAY, firstReviewAt: new Date(t - 2.5 * DAY) }, t),
    ).toBeNull();
    expect(overDay({ ...base, readyAt: t - 3 * DAY, draft: true }, t)).toBeNull();
    expect(overDay({ ...base, readyAt: null }, t)).toBeNull();
  });
});
