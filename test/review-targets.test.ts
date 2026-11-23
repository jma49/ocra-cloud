import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import type { Outbox } from "../src/notify/notify.js";
import type {
  AtRiskView,
  NotifyChannelView,
  NotifyEvent,
  ReviewTargetsView,
} from "../src/shared/index.js";
import { DAY, HOUR } from "../src/time.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// Review targets and the pull requests at risk of them: set per account and
// enrolled repository, read from what the webhooks stored, told once per
// pull request and target by the hourly run, held in quiet hours, never
// across accounts.

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";

const out: Outbox = {
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: "https://console.test",
};

/** The hourly run at the time given; on a server without pull_at_risk it tells nothing. */
async function hourly(at: number) {
  vi.setSystemTime(at);
  const run = await import("../src/notify/at-risk.js").catch(() => undefined);
  await run?.runAtRisk(db, out, 90, new Date(at));
}

async function account(githubId: number, login: string, repos: string[] = ["repo"]) {
  const me = await signIn(githubId, login);
  const data = scoped(db, me.account.id);
  for (const [i, id] of repos.entries()) {
    await data.insert("reviewRepos", {
      id,
      platform: "github",
      host: "github.com",
      platformRepoId: `${githubId}-${i}`,
      fullName: `${login}/${id}`,
    });
  }
  return { me, data };
}

const put = (auth: Record<string, string>, path: string, json: unknown) =>
  call(`/api/review-targets${path}`, { method: "PUT", auth, json });

const targets = (firstReviewHours: number | null, mergeDays: number | null) => ({
  firstReviewHours,
  mergeDays,
});

function flow(
  data: ReturnType<typeof scoped>,
  number: number,
  readyHoursAgo: number,
  now: number,
  extra: object = {},
) {
  const at = new Date(now - readyHoursAgo * HOUR);
  return data.pullFlows.record({
    reviewRepoId: "repo",
    number,
    title: `Pull ${number}`,
    author: "hubot",
    authorId: "7",
    draft: false,
    size: 3,
    openedAt: at,
    seenAt: new Date(now - HOUR),
    ...extra,
  });
}

async function atRisk(auth: Record<string, string>, query = "") {
  const res = await call(`/api/insights/at-risk${query}`, { auth });
  expect(res.status).toBe(200);
  return (await res.json()) as AtRiskView;
}

function chats() {
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    posted.push(((await req.json()) as { text: string }).text);
    return new Response("ok");
  });
  return posted;
}

async function addChannel(
  auth: Record<string, string>,
  extra: { events?: NotifyEvent[]; quietHours?: unknown } = {},
) {
  const res = await call("/api/notifications/channels", {
    method: "POST",
    auth,
    json: {
      kind: "slack",
      url: SLACK,
      name: "team",
      when: "blocking",
      events: ["pull_at_risk"],
      ...extra,
    },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { channel: NotifyChannelView }).channel;
}

describe("the targets", () => {
  it("are none until set, then the default and a repository's own in its place", async () => {
    const { me } = await account(1, "mona", ["repo", "web"]);
    const read = async () =>
      (await (await call("/api/review-targets", { auth: me.auth })).json()) as ReviewTargetsView;
    expect(await read()).toEqual({
      default: targets(null, null),
      repos: [
        { reviewRepoId: "repo", platform: "github", fullName: "mona/repo", targets: null },
        { reviewRepoId: "web", platform: "github", fullName: "mona/web", targets: null },
      ],
    });
    expect(await (await put(me.auth, "/default", targets(24, 7))).json()).toEqual(targets(24, 7));
    expect((await put(me.auth, "/default", targets(8, null))).status).toBe(200);
    expect((await put(me.auth, "/repos/web", targets(null, 3))).status).toBe(200);
    const view = await read();
    expect(view.default).toEqual(targets(8, null));
    expect(view.repos.map((r) => r.targets)).toEqual([null, targets(null, 3)]);

    const cleared = await call("/api/review-targets/repos/web", {
      method: "DELETE",
      auth: me.auth,
    });
    expect(await cleared.json()).toEqual({ removed: true });
    expect((await read()).repos.map((r) => r.targets)).toEqual([null, null]);
  });

  it("refuse values out of range, and a repository the account does not enroll", async () => {
    const { me } = await account(1, "mona");
    await account(2, "other", ["theirs"]);
    for (const body of [
      targets(0, 7),
      targets(24, 91),
      targets(721, null),
      targets(1.5, null),
      { firstReviewHours: 24 },
    ]) {
      expect((await put(me.auth, "/default", body)).status).toBe(400);
    }
    expect((await put(me.auth, "/repos/theirs", targets(4, 2))).status).toBe(404);
    expect((await put(me.auth, "/repos/nope", targets(4, 2))).status).toBe(404);
    const other = scoped(db, (await signIn(2, "other")).account.id);
    expect(await other.list("reviewTargets")).toEqual([]);
  });

  it("are in the account's export", async () => {
    const { me } = await account(1, "mona");
    await put(me.auth, "/repos/repo", targets(6, null));
    const body = (await (await call("/api/export", { auth: me.auth })).json()) as {
      reviewTargets: unknown[];
    };
    expect(body.reviewTargets).toEqual([
      expect.objectContaining({ scope: "repo", firstReviewHours: 6, mergeDays: null }),
    ]);
  });

  it("go with their repository", async () => {
    const { me, data } = await account(1, "mona");
    expect((await put(me.auth, "/repos/repo", targets(4, 2))).status).toBe(200);
    expect(await data.list("reviewTargets")).toHaveLength(1);
    expect(await data.remove("reviewRepos", "repo")).toBe(true);
    expect(await data.list("reviewTargets")).toEqual([]);
  });
});

describe("the pull requests at risk", () => {
  it("lists those past or near a target, past first, then the earliest due", async () => {
    const { me, data } = await account(1, "mona");
    const now = Date.now();
    await put(me.auth, "/default", targets(10, 2));
    await flow(data, 1, 12, now); // first review past (due 2h ago)
    await flow(data, 2, 8, now); // first review near (80%)
    await flow(data, 3, 5, now); // neither yet
    await flow(data, 4, 40, now, { readyAt: new Date(now - 40 * HOUR) }); // merge near, first past
    await flow(data, 5, 60, now); // merge past and first past
    await data.pullFlows.review(
      {
        reviewRepoId: "repo",
        number: 5,
        title: "Pull 5",
        author: "hubot",
        draft: false,
        size: 3,
        seenAt: new Date(now - HOUR),
      },
      {
        reviewKey: "r5",
        reviewer: "octo",
        approved: false,
        submittedAt: new Date(now - 50 * HOUR),
      },
    );
    const view = await atRisk(me.auth);
    expect(view.targetsSet).toBe(true);
    expect(view.pulls.map((p) => [p.number, p.target, p.state])).toEqual([
      [4, "first_review", "past"],
      [5, "merge", "past"],
      [1, "first_review", "past"],
      [2, "first_review", "near"],
      [4, "merge", "near"],
    ]);
    const first = view.pulls.find((p) => p.number === 1);
    expect(first).toMatchObject({ platform: "github", repo: "mona/repo", title: "Pull 1" });
    expect(Date.parse(first?.due ?? "") - Date.parse(first?.since ?? "")).toBe(10 * HOUR);
  });

  it("leaves out drafts, closed pull requests and repositories without a target", async () => {
    const { me, data } = await account(1, "mona", ["repo", "web"]);
    const now = Date.now();
    await put(me.auth, "/default", targets(4, null));
    await put(me.auth, "/repos/web", targets(null, null));
    await flow(data, 1, 10, now, { draft: true });
    await flow(data, 2, 10, now);
    await flow(data, 3, 10, now);
    await flow(data, 4, 10, now, { reviewRepoId: "web" });
    await data.insert("closedPulls", {
      reviewRepoId: "repo",
      number: 2,
      title: "T",
      merged: true,
      closedAt: new Date(now - HOUR),
    });
    const view = await atRisk(me.auth);
    expect(view.pulls.map((p) => p.number)).toEqual([3]);
    expect((await atRisk(me.auth, "?repo=mona/web")).pulls).toEqual([]);
    expect((await call("/api/insights/at-risk?repo=mona/nope", { auth: me.auth })).status).toBe(
      404,
    );
  });

  it("names whom it waits on, and starts a reopened pull request's first review again", async () => {
    const { me, data } = await account(1, "mona");
    const now = Date.now();
    await put(me.auth, "/default", targets(4, null));
    await flow(data, 1, 30, now, { reopenedAt: new Date(now - 2 * HOUR) });
    await flow(data, 2, 5, now);
    await data.reviewRequests.asked({
      reviewRepoId: "repo",
      number: 2,
      reviewerId: "9",
      reviewer: "octo",
      at: new Date(now - 4 * HOUR),
    });
    await data.reviewRequests.asked({
      reviewRepoId: "repo",
      number: 2,
      reviewerId: "10",
      reviewer: "done",
      at: new Date(now - 4 * HOUR),
    });
    await data.reviewRequests.done({
      reviewRepoId: "repo",
      number: 2,
      reviewerId: "10",
      at: new Date(now - HOUR),
    });
    const view = await atRisk(me.auth);
    expect(view.pulls.map((p) => [p.number, p.state, p.waitingOn])).toEqual([
      [2, "past", ["octo"]],
    ]);
  });

  it("is empty without targets, and never another account's", async () => {
    const { me } = await account(1, "mona");
    const other = await account(2, "other", ["repo2"]);
    const now = Date.now();
    await put(other.me.auth, "/default", targets(1, 1));
    await other.data.pullFlows.record({
      reviewRepoId: "repo2",
      number: 1,
      title: "Theirs",
      author: "x",
      draft: false,
      size: 1,
      openedAt: new Date(now - 3 * DAY),
      seenAt: new Date(now - HOUR),
    });
    expect(await atRisk(me.auth)).toEqual({
      repo: null,
      pulls: [],
      targetsSet: false,
      capped: false,
    });
    await put(me.auth, "/default", targets(1, 1));
    expect((await atRisk(me.auth)).pulls).toEqual([]);
    expect((await atRisk(other.me.auth)).pulls).toHaveLength(2);
  });
});

describe("pull_at_risk", () => {
  const now = Date.UTC(2026, 10, 20, 12, 30);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });

  it("tells each channel of a pull request once per target, however often the run goes", async () => {
    const { me, data } = await account(1, "mona");
    await put(me.auth, "/default", targets(10, 30));
    await addChannel(me.auth);
    await addChannel(me.auth, { events: ["pull_reviewed"] });
    await flow(data, 1, 9, now);
    const posted = chats();
    await Promise.all([hourly(now), hourly(now)]);
    await hourly(now + 2 * HOUR);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("At risk of a review target (1):");
    expect(posted[0]).toContain("<https://console.test/pull/github/mona%2Frepo/1|mona/repo#1>");
    expect(posted[0]).toContain("Pull 1 · first review due in 1h 0m");
    vi.setSystemTime(now + 3 * HOUR);
    await put(me.auth, "/default", targets(2, 30));
    await hourly(now + 3 * HOUR);
    expect(posted).toHaveLength(1);
  });

  it("holds it in quiet hours and tells it when they end", async () => {
    const { me, data } = await account(1, "mona");
    await put(me.auth, "/default", targets(4, null));
    await addChannel(me.auth, { quietHours: { start: 12, end: 13 } });
    await flow(data, 1, 5, now);
    const posted = chats();
    await hourly(now);
    expect(posted).toEqual([]);
    await hourly(now + HOUR);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("first review overdue by 2h 0m");
  });

  it("never tells one that came near its target over a week ago, nor another account", async () => {
    const { me, data } = await account(1, "mona");
    const other = await account(2, "other", ["repo2"]);
    await put(me.auth, "/default", targets(1, null));
    await addChannel(other.me.auth);
    await put(other.me.auth, "/default", targets(1, null));
    await flow(data, 1, 2, now);
    await flow(data, 2, 9 * 24, now);
    const posted = chats();
    await hourly(now);
    expect(posted).toEqual([]);
    await addChannel(me.auth);
    await hourly(now);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("mona/repo#1");
    expect(posted[0]).not.toContain("mona/repo#2");
  });
});
