import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import { weekStart } from "../src/flow.js";
import type { InsightsFlowView } from "../src/shared/index.js";
import { C1, repoFake } from "./graph-fakes.js";
import { graphServer, SECRET, type Server } from "./graph-server.js";

// An enrolled repository's pull requests on their way to review: the
// platforms' webhooks record each step once, the earliest winning, and the
// Insights page's review flow reads them back.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-pull-flows-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let s: Server;
beforeEach(async () => {
  s = await graphServer(dir, `pull-flows-${n++}.db`, "off", undefined, { bots: {}, workers: 0 });
  repoFake({ [C1]: {} });
});
afterEach(() => s.host.close());

const HOUR = 3_600_000;
const base = Date.now() - 5 * 24 * HOUR;
const at = (hours: number) => new Date(base + hours * HOUR).toISOString();

const enroll = (auth: Record<string, string>, json: Record<string, unknown>) =>
  s.call("/api/auto-review/repos", { method: "POST", headers: auth, json });

const pull = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  draft: false,
  head: { sha: C1 },
  title: `Pull ${number}`,
  user: { login: "octo", type: "User" },
  created_at: at(0),
  updated_at: at(0),
  additions: 30,
  deletions: 5,
  ...fields,
});

async function fromGithub(event: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ repository: { id: 11, full_name: "octo/api" }, ...payload });
  return s.call("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
    },
    body,
  });
}

const pullEvent = (action: string, number: number, fields: Record<string, unknown> = {}) =>
  fromGithub("pull_request", { action, number, pull_request: pull(number, fields) });

const review = (number: number, id: number, login: string, state: string, hours: number) =>
  fromGithub("pull_request_review", {
    action: "submitted",
    review: {
      id,
      user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
      state,
      submitted_at: at(hours),
    },
    pull_request: pull(number),
  });

const flows = async () =>
  (await s.host.db.select().from(schema.pullFlows).orderBy(schema.pullFlows.number)).map((p) => ({
    number: p.number,
    author: p.author,
    draft: p.draft,
    size: p.size,
    opened: p.openedAt?.toISOString() ?? null,
    ready: p.readyAt?.toISOString() ?? null,
    requested: p.firstReviewRequestedAt?.toISOString() ?? null,
    reviewed: p.firstReviewAt?.toISOString() ?? null,
    approved: p.firstApprovalAt?.toISOString() ?? null,
  }));

const reviews = async () =>
  (await s.host.db.select().from(schema.pullReviews).orderBy(schema.pullReviews.submittedAt)).map(
    (r) => [r.number, r.reviewer, r.approved],
  );

describe("a pull request's way to review on GitHub", () => {
  it("keeps the first of each step once, leaving out the author's and bots' reviews", async () => {
    const { auth } = await s.signIn(1);
    await enroll(auth, { platform: "github", fullName: "octo/api" });
    await pullEvent("opened", 7, { draft: true });
    await pullEvent("ready_for_review", 7, { updated_at: at(2) });
    await pullEvent("review_requested", 7, { updated_at: at(3) });
    // A later request, then an earlier one delivered late: the earliest stays.
    await pullEvent("review_requested", 7, { updated_at: at(6) });
    await pullEvent("review_requested", 7, { updated_at: at(2.5) });
    await review(7, 100, "octo", "commented", 3.5);
    await review(7, 101, "ocra-review[bot]", "commented", 3.6);
    const twice = await Promise.all([
      review(7, 102, "mona", "changes_requested", 4),
      review(7, 102, "mona", "changes_requested", 4),
    ]);
    expect(twice.map((r) => r.status)).toEqual([202, 202]);
    await review(7, 103, "hubot", "approved", 8);
    await review(7, 104, "mona", "approved", 9);
    // Not enrolled: nothing is kept.
    await fromGithub("pull_request", {
      action: "opened",
      number: 9,
      pull_request: pull(9),
      repository: { id: 99, full_name: "other/repo" },
    });

    expect(await flows()).toEqual([
      {
        number: 7,
        author: "octo",
        draft: false,
        size: 35,
        opened: at(0),
        ready: at(2),
        requested: at(2.5),
        reviewed: at(4),
        approved: at(8),
      },
    ]);
    expect(await reviews()).toEqual([
      [7, "mona", false],
      [7, "hubot", true],
      [7, "mona", true],
    ]);
  });

  it("answers the review flow of the account's enrolled repositories", async () => {
    const { auth } = await s.signIn(1);
    await enroll(auth, { platform: "github", fullName: "octo/api" });
    // 7: reviewed after 4 hours, approved after 8, merged an hour later.
    await pullEvent("opened", 7);
    await review(7, 1, "mona", "commented", 4);
    await review(7, 2, "hubot", "approved", 8);
    await pullEvent("closed", 7, { merged: true, merged_at: at(9), closed_at: at(9) });
    // 8 waits for review, asked for; 10 waits longer, without; 11 is a draft.
    const large = { created_at: at(10), additions: 900, deletions: 200 };
    await pullEvent("opened", 8, large);
    await pullEvent("review_requested", 8, { ...large, updated_at: at(11) });
    await pullEvent("opened", 10, { created_at: at(5), additions: 2, deletions: 1 });
    await pullEvent("opened", 11, { draft: true, created_at: at(1) });
    // 12 closed without review: not waiting.
    await pullEvent("opened", 12, { created_at: at(1) });
    await pullEvent("closed", 12, { merged: false, closed_at: at(2) });

    const res = await s.call("/api/insights/flow?days=30", { headers: auth });
    expect(res.status).toBe(200);
    const view = (await res.json()) as InsightsFlowView;
    expect(view.repo).toBeNull();
    expect(view.toFirstReview).toEqual({ median: 4 * HOUR, p90: 4 * HOUR, count: 1 });
    expect(view.toFirstApproval).toEqual({ median: 8 * HOUR, p90: 8 * HOUR, count: 1 });
    expect(view.approvalToMerge).toEqual({ median: HOUR, p90: HOUR, count: 1 });
    expect(view.waiting.map((w) => [w.number, w.title, w.reviewRequested])).toEqual([
      [10, "Pull 10", false],
      [8, "Pull 8", true],
    ]);
    expect(view.reviewers).toEqual([
      { login: "hubot", reviews: 1, approvals: 1, pulls: 1 },
      { login: "mona", reviews: 1, approvals: 0, pulls: 1 },
    ]);
    expect(view.sizes).toEqual({ xs: 1, s: 3, m: 0, l: 0, xl: 1, unknown: 0 });
    const opened = view.weeks.reduce((sum, w) => sum + w.opened, 0);
    expect([opened, view.weeks.reduce((sum, w) => sum + w.merged, 0)]).toEqual([5, 1]);
    const merged = view.weeks.find((w) => w.merged === 1);
    expect(merged?.start).toBe(new Date(weekStart(Date.parse(at(9)))).toISOString().slice(0, 10));
    expect(view.capped).toBe(false);

    const one = await s.call("/api/insights/flow?days=7&repo=octo/api", { headers: auth });
    expect(((await one.json()) as InsightsFlowView).repo).toBe("octo/api");
    // Another account sees none of it, and a repository it did not enroll is not found.
    const other = await s.signIn(2);
    const theirs = (await (
      await s.call("/api/insights/flow", { headers: other.auth })
    ).json()) as InsightsFlowView;
    expect([theirs.waiting, theirs.reviewers, theirs.toFirstReview.count]).toEqual([[], [], 0]);
    const missing = await s.call("/api/insights/flow?repo=octo/api", { headers: other.auth });
    expect(missing.status).toBe(404);
  });
});

describe("a merge request's way to review on GitLab", () => {
  it("is kept from the merge request hook, an approval once per approver", async () => {
    vi.useFakeTimers({ now: new Date(at(6)), toFake: ["Date"] });
    const { auth } = await s.signIn(1);
    const res = await enroll(auth, { platform: "gitlab", fullName: "group/api" });
    const { webhook } = (await res.json()) as { webhook: { secret: string } };
    const hook = (
      attributes: Record<string, unknown>,
      user: { id: number; username: string },
      extra: Record<string, unknown> = {},
    ) =>
      s.call("/api/auto-review/webhooks/gitlab", {
        method: "POST",
        headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": webhook.secret },
        json: {
          object_attributes: {
            iid: 3,
            last_commit: { id: C1 },
            title: "Add the cache",
            author_id: 1,
            draft: false,
            created_at: at(0).replace("T", " ").replace(".000Z", " UTC"),
            ...attributes,
          },
          user,
          project: { id: 21, path_with_namespace: "group/api" },
          ...extra,
        },
      });
    const octo = { id: 1, username: "octo" };
    const mona = { id: 2, username: "mona" };
    await hook({ action: "open", reviewer_ids: [2] }, octo);
    // The author's own approval is not a review.
    await hook({ action: "approval" }, octo);
    await hook({ action: "approval" }, mona);
    await hook({ action: "approved" }, mona);
    vi.useRealTimers();
    expect(await flows()).toEqual([
      {
        number: 3,
        author: "octo",
        draft: false,
        size: null,
        opened: at(0),
        ready: at(0),
        requested: at(6),
        reviewed: at(6),
        approved: at(6),
      },
    ]);
    expect(await reviews()).toEqual([[3, "mona", true]]);
  });
});
