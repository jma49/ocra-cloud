import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { claimJob } from "../src/db/review-jobs.js";
import * as schema from "../src/db/schema.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import type { PullReviewNowView } from "../src/shared/index.js";
import { C1, C2, C3, repoFake } from "./graph-fakes.js";
import { graphServer, type Server } from "./graph-server.js";

/** A daily cap on gateway calls no test reaches unless it means to. */
const CALLS = 1000;

// "Review now": a review of a pull request's current head, asked for on the
// console, for a repository the account enrolled for auto review.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-review-now-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let s: Server;
let auth: Record<string, string>;
const pull = (head: string) => ({ 7: { base: C1, head, files: [] } });

beforeEach(async () => {
  s = await graphServer(dir, `review-now-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api },
    workers: 0,
  });
  repoFake({ [C1]: {} }, C1, pull(C2));
  auth = (await s.signIn(1)).auth;
  const enrolled = await s.call("/api/auto-review/repos", {
    method: "POST",
    headers: auth,
    json: { platform: "github", fullName: "octo/api" },
  });
  expect(enrolled.status).toBe(200);
});
afterEach(() => s.host.close());

const ref = { platform: "github", repo: "octo/api", number: 7 };

async function request(json: Record<string, unknown> = {}, headers = auth) {
  const res = await s.call("/api/pulls/review-now", {
    method: "POST",
    headers,
    json: { ...ref, ...json },
  });
  return { status: res.status, body: (await res.json()) as PullReviewNowView };
}

async function latest(number = 7) {
  const res = await s.call(`/api/pulls/review-now?platform=github&repo=octo/api&number=${number}`, {
    headers: auth,
  });
  return (await res.json()) as PullReviewNowView;
}

const jobs = () => s.host.db.select().from(schema.reviewJobs).orderBy(schema.reviewJobs.createdAt);

describe("a review asked for on the console", () => {
  it("queues the platform's head once, whatever the request names", async () => {
    expect(await latest()).toEqual({ job: null, depth: "standard", live: null });
    const first = await request({ head: C3 });
    expect(first).toMatchObject({ status: 200, body: { job: { state: "queued", head: C2 } } });
    const again = await request();
    expect(again.body.job?.jobId).toBe(first.body.job?.jobId);
    expect(await jobs()).toMatchObject([{ number: 7, head: C2, run: 0, state: "queued" }]);
    expect(await latest()).toEqual(first.body);
    // Another pull request of the repository has its own jobs.
    expect(await latest(8)).toEqual({ job: null, depth: "standard", live: null });
  });

  it("queues for a repository whose automatic reviews are switched off", async () => {
    const [repo] = await s.host.db.select().from(schema.reviewRepos);
    const off = await s.call(`/api/auto-review/repos/${repo?.id}/automatic`, {
      method: "PUT",
      headers: auth,
      json: { automatic: false },
    });
    expect(await off.json()).toEqual({ automatic: false });
    expect(await request()).toMatchObject({ status: 200, body: { job: { state: "queued" } } });
  });

  it("answers a running review instead of a second, even when forced", async () => {
    const first = await request();
    await claimJob(s.host.db, new Date(), 60_000, CALLS);
    const forced = await request({ force: true });
    expect(forced.body.job).toMatchObject({ jobId: first.body.job?.jobId, state: "running" });
    expect(await jobs()).toHaveLength(1);
  });

  it("reviews a reviewed head again only when forced, as its next run", async () => {
    await request();
    const claimed = await claimJob(s.host.db, new Date(), 60_000, CALLS);
    await s.host.db
      .update(schema.reviewJobs)
      .set({ state: "done", finishedAt: new Date() })
      .where(eq(schema.reviewJobs.id, claimed?.id ?? ""));
    expect((await request()).body.job).toMatchObject({ state: "done" });
    const [a, b] = await Promise.all([request({ force: true }), request({ force: true })]);
    expect(a.body.job?.jobId).toBe(b.body.job?.jobId);
    expect((await jobs()).map((j) => [j.run, j.state])).toEqual([
      [0, "done"],
      [1, "queued"],
    ]);
    expect((await latest()).job).toMatchObject({ jobId: a.body.job?.jobId, state: "queued" });
  });

  it("supersedes a queued older head of the same pull request", async () => {
    await request();
    vi.restoreAllMocks();
    repoFake({ [C1]: {} }, C1, pull(C3));
    await request();
    expect((await jobs()).map((j) => [j.head, j.state])).toEqual([
      [C2, "superseded"],
      [C3, "queued"],
    ]);
  });

  it("is queued even when a rule skips the pull request's reviews", async () => {
    const rule = await s.call("/api/automations/rules", {
      method: "POST",
      headers: auth,
      json: {
        name: "never",
        trigger: "queued",
        conditions: {},
        actions: [{ kind: "skip_review" }],
      },
    });
    expect(rule.status).toBe(200);
    expect((await request()).body.job).toMatchObject({ state: "queued" });
  });

  it("is refused for a repository this account did not enroll, or a pull request not read", async () => {
    const other = await s.signIn(2);
    expect((await request({}, other.auth)).status).toBe(404);
    expect((await request({ number: 8 })).status).toBe(404);
    expect(await jobs()).toEqual([]);
  });
});
