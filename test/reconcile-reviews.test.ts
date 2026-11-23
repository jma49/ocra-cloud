import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./helpers.js";
import { GITLAB } from "./platform-fakes.js";
import { account, hourly } from "./reconcile-fakes.js";

// The daily reconciliation's pass over open pull requests changed lately:
// the reviews and asks of a review their webhooks missed are filled in, an
// ask the server holds that the platform ended ends, and a webhook's own
// record, or one that arrived since the platform was read, stands. A
// platform that did not answer is tried again a few times a day.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const API = "https://api.github.com";

type Open = {
  number: number;
  updated: Date;
  reviewers?: { id: number; login: string }[];
  teams?: { id: number; slug: string }[];
  reviews?: {
    id: number;
    user: { id: number; login: string; type?: string };
    state: string;
    at: Date;
  }[];
};

let calls = 0;

/** GitHub and GitLab answering with each repository's open pull requests; false answers 500 to every call. */
function platformsWith(pulls: Record<string, Open[]>, answers = true) {
  const reads: string[] = [];
  calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls++;
    const url = new URL(new Request(input, init).url);
    if (!answers) return new Response("{}", { status: 500 });
    const gh = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls(?:\/(\d+)\/reviews)?$/);
    if (url.origin === API && gh?.[1]) {
      const list = pulls[gh[1]] ?? [];
      if (gh[2]) {
        const p = list.find((x) => x.number === Number(gh[2]));
        return Response.json(
          (p?.reviews ?? []).map((v) => ({
            id: v.id,
            user: v.user,
            state: v.state,
            submitted_at: v.at.toISOString(),
          })),
        );
      }
      reads.push(gh[1]);
      if (url.searchParams.get("state") !== "open") return Response.json([]);
      return Response.json(
        list.map((p) => ({
          number: p.number,
          title: `Pull ${p.number}`,
          state: "open",
          draft: false,
          user: { login: "dev", id: 99 },
          created_at: new Date(p.updated.getTime() - DAY).toISOString(),
          updated_at: p.updated.toISOString(),
          requested_reviewers: p.reviewers ?? [],
          requested_teams: p.teams ?? [],
        })),
      );
    }
    const gl = url.pathname.match(
      /^\/api\/v4\/projects\/([^/]+)\/merge_requests(?:\/(\d+)\/approvals)?$/,
    );
    if (url.origin === GITLAB && gl?.[1]) {
      const list = pulls[decodeURIComponent(gl[1])] ?? [];
      if (gl[2]) {
        const p = list.find((x) => x.number === Number(gl[2]));
        return Response.json({
          approved_by: (p?.reviews ?? []).map((v) => ({
            user: { id: v.user.id, username: v.user.login },
            approved_at: v.at.toISOString(),
          })),
        });
      }
      if (url.searchParams.get("state") !== "opened") return Response.json([]);
      return Response.json(
        list.map((p) => ({
          iid: p.number,
          title: `MR ${p.number}`,
          state: "opened",
          author: { username: "dev", id: 5 },
          created_at: new Date(p.updated.getTime() - DAY).toISOString(),
          updated_at: p.updated.toISOString(),
          reviewers: (p.reviewers ?? []).map((u) => ({ id: u.id, username: u.login })),
        })),
      );
    }
    return new Response("{}", { status: 404 });
  });
  return reads;
}

type Account = Awaited<ReturnType<typeof account>>;

async function ask(
  a: Account,
  repo: string,
  number: number,
  reviewerId: string,
  requested: Date,
  done?: Date,
) {
  const e = { reviewRepoId: a.repo(repo), number, reviewerId, reviewer: `u${reviewerId}` };
  await a.data.reviewRequests.asked({ ...e, at: requested });
  if (done) await a.data.reviewRequests.done({ ...e, at: done });
}

async function asks(a: Account) {
  const all = await a.data.list("reviewRequests");
  return new Map(all.map((r) => [r.reviewerId, r]));
}

describe("the daily reconciliation of reviews", () => {
  it("fills in the reviews and asks a GitHub pull request's webhooks missed", async () => {
    const now = Date.now();
    const a = await account(1, [{ name: "octo/api" }]);
    const updated = new Date(now - HOUR);
    const reviewed = new Date(now - 2 * HOUR);
    // Asked, then reviewed: the review's webhook was lost.
    await ask(a, "octo/api", 1, "12", new Date(now - 3 * HOUR));
    // Asked, then asked no more: the removal's webhook was lost.
    await ask(a, "octo/api", 1, "13", new Date(now - 4 * HOUR));
    // Reviewed, then asked again: the new ask's webhook was lost.
    const doneDee = new Date(now - 5 * HOUR);
    await ask(a, "octo/api", 1, "14", new Date(now - 6 * HOUR), doneDee);
    // Asked after the platform was read: its webhook stands.
    const lateAsk = new Date(now - 10 * MINUTE);
    await ask(a, "octo/api", 1, "15", lateAsk);
    platformsWith({
      "octo/api": [
        {
          number: 1,
          updated,
          reviewers: [
            { id: 11, login: "ana" },
            { id: 14, login: "dee" },
          ],
          teams: [{ id: 7, slug: "core" }],
          reviews: [
            { id: 500, user: { id: 12, login: "bo" }, state: "APPROVED", at: reviewed },
            { id: 501, user: { id: 99, login: "dev" }, state: "COMMENTED", at: reviewed },
            {
              id: 502,
              user: { id: 3, login: "lint[bot]", type: "Bot" },
              state: "COMMENTED",
              at: reviewed,
            },
            { id: 503, user: { id: 12, login: "bo" }, state: "PENDING", at: reviewed },
          ],
        },
      ],
    });
    const run = Date.now();

    await hourly();

    const reviews = await a.data.list("pullReviews");
    expect(reviews).toMatchObject([
      { reviewKey: "github:500", reviewer: "bo", approved: true, submittedAt: reviewed },
    ]);
    const [flow] = await a.data.list("pullFlows");
    expect(flow).toMatchObject({ number: 1, firstReviewAt: reviewed, firstApprovalAt: reviewed });

    const byId = await asks(a);
    expect(byId.get("12")?.doneAt).toEqual(reviewed);
    expect(byId.get("13")?.doneAt).toEqual(updated);
    expect(byId.get("15")).toMatchObject({ requestedAt: lateAsk, doneAt: null });
    // Started or asked again at the run, never earlier: no reminder counts a wait before it.
    for (const id of ["11", "14", "team:7"]) {
      const row = byId.get(id);
      expect(row?.requestedAt.getTime()).toBeGreaterThanOrEqual(run);
      expect(row?.doneAt === null || (row?.doneAt ?? 0) < (row?.requestedAt ?? 0)).toBe(true);
    }
    expect(byId.get("11")?.reviewer).toBe("ana");
    expect(byId.get("team:7")?.reviewer).toBe("octo/core");
    expect(byId.get("14")?.doneAt).toEqual(doneDee);

    // The next day's run changes nothing the first one filled.
    const before = await a.data.list("reviewRequests");
    vi.useFakeTimers({ now: now + DAY, toFake: ["Date"] });
    try {
      await hourly();
    } finally {
      vi.useRealTimers();
    }
    expect(await a.data.list("pullReviews")).toHaveLength(1);
    expect(await a.data.list("reviewRequests")).toEqual(before);
  });

  it("ends a GitLab reviewer's ask at their approval and leaves an approval rule's group alone", async () => {
    const now = Date.now();
    const a = await account(1, [{ name: "group/app", platform: "gitlab" }]);
    const approvedAt = new Date(now - 2 * HOUR);
    await ask(a, "group/app", 7, "22", new Date(now - 3 * HOUR));
    await ask(a, "group/app", 7, "team:9", new Date(now - 3 * HOUR));
    platformsWith({
      "group/app": [
        {
          number: 7,
          updated: new Date(now - HOUR),
          reviewers: [
            { id: 21, login: "gil" },
            { id: 22, login: "hal" },
          ],
          reviews: [{ id: 0, user: { id: 22, login: "hal" }, state: "approved", at: approvedAt }],
        },
      ],
    });

    await hourly();

    expect(await a.data.list("pullReviews")).toMatchObject([
      { reviewKey: "gitlab:7:approval:22", reviewer: "hal", approved: true },
    ]);
    const byId = await asks(a);
    expect(byId.get("22")?.doneAt).toEqual(approvedAt);
    expect(byId.get("21")).toMatchObject({ reviewer: "gil", doneAt: null });
    expect(byId.get("team:9")?.doneAt).toBeNull();
  });

  it("leaves pull requests that did not change since before enrollment", async () => {
    const a = await account(1, [{ name: "octo/api" }]);
    platformsWith({
      "octo/api": [
        {
          number: 1,
          updated: new Date(Date.now() - 2 * DAY),
          reviewers: [{ id: 11, login: "ana" }],
        },
      ],
    });
    await hourly();
    // The closed and open listings: no pull request read on its own.
    expect(calls).toBe(2);
    expect(await a.data.list("reviewRequests")).toEqual([]);
  });

  it("gives back a repository whose reviews the budget cut short, and finishes it on the next run", async () => {
    const accounts: Account[] = [];
    const pulls: Record<string, Open[]> = {};
    // Twelve calls each: two listings and the reviews of ten of its eleven open pull requests.
    for (const n of [1, 2, 3, 4]) {
      const name = `org${n}/app`;
      accounts.push(await account(n, [{ name }]));
      pulls[name] = Array.from({ length: 11 }, (_, i) => ({
        number: i + 1,
        updated: new Date(Date.now() - (i + 1) * MINUTE),
        reviews: [
          {
            id: n * 100 + i,
            user: { id: 12, login: "bo" },
            state: "COMMENTED",
            at: new Date(Date.now() - HOUR),
          },
        ],
      }));
    }
    const kept = () =>
      Promise.all(accounts.map(async (a) => (await a.data.list("pullReviews")).length));
    platformsWith(pulls);

    await hourly();
    expect(calls).toBeLessThanOrEqual(45);
    expect(await kept()).not.toEqual([10, 10, 10, 10]);

    await hourly();
    // The ten most lately changed of each.
    expect(await kept()).toEqual([10, 10, 10, 10]);
  });

  it("tries a repository whose platform did not answer again, three times a day", async () => {
    await account(1, [{ name: "octo/api" }]);
    const reads = platformsWith({}, false);
    for (let i = 0; i < 5; i++) await hourly();
    // Each try lists closed and open pull requests.
    expect(calls).toBe(3 * 2);
    expect(reads).toEqual([]);
  });

  it("writes an ask or its end only as it was read, so a webhook's since stands", async () => {
    const now = Date.now();
    const a = await account(1, [{ name: "octo/api" }]);
    const requestedAt = new Date(now - 3 * HOUR);
    const doneAt = new Date(now - 2 * HOUR);
    await ask(a, "octo/api", 1, "12", requestedAt, doneAt);
    await ask(a, "octo/api", 1, "13", requestedAt);
    // Webhooks since the read: 12 asked again, 13 asked again later.
    const webhookAsk = new Date(now - HOUR);
    await ask(a, "octo/api", 1, "12", webhookAsk);
    await ask(a, "octo/api", 1, "13", webhookAsk);
    const e = { reviewRepoId: a.repo("octo/api"), number: 1, at: new Date(now) };
    await a.data.reviewRequests.askedAgain({ ...e, reviewerId: "12" }, { requestedAt, doneAt });
    await a.data.reviewRequests.endedSince({ ...e, reviewerId: "13" }, { requestedAt });
    const byId = await asks(a);
    expect(byId.get("12")).toMatchObject({ requestedAt: webhookAsk, doneAt });
    expect(byId.get("13")).toMatchObject({ requestedAt: webhookAsk, doneAt: null });
  });
});
