import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import { claimJob } from "../src/db/review-jobs.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import type { AuditPage } from "../src/shared/index.js";
import { auditLines, lines } from "../test/audit-lines.js";
import { C1, C2, C3, repoFake } from "./graph-fakes.js";
import { graphServer, ORIGIN, SECRET, type Server } from "./graph-server.js";

// Pull requests the server reviews itself (ADR-0046): a repository one
// account enrolls, whose pull requests' heads the platforms' webhooks queue.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-auto-review-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let s: Server;
beforeEach(async () => {
  // No worker: the jobs stay as the webhooks leave them.
  s = await graphServer(dir, `auto-review-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api },
    workers: 0,
  });
  repoFake({ [C1]: {} });
});
afterEach(() => s.host.close());

const enroll = (auth: Record<string, string>, json: Record<string, unknown>) =>
  s.call("/api/auto-review/repos", { method: "POST", headers: auth, json });

const pullEvent = (action: string, head: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    action,
    number: 7,
    pull_request: { draft: false, head: { sha: head }, ...over },
    repository: { id: 11, full_name: "Octo/API" },
  });

async function fromGithub(body: string, event = "pull_request", signature?: string) {
  return s.call("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signature ?? `sha256=${await hmacHex(SECRET, body)}`,
    },
    body,
  });
}

const jobs = () => s.host.db.select().from(schema.reviewJobs).orderBy(schema.reviewJobs.createdAt);

describe("a repository enrolled for auto review", () => {
  it("is read as the account and names the App's webhook", async () => {
    const { auth } = await s.signIn(1);
    const res = await enroll(auth, { platform: "github", fullName: "octo/api" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhook: Record<string, unknown> };
    expect(body).toMatchObject({
      repo: { fullName: "Octo/API", host: "github.com", latest: null },
      webhook: { url: `${ORIGIN}/api/webhooks/github` },
    });
    expect(body.webhook).not.toHaveProperty("secret");
    const listed = await (await s.call("/api/auto-review/repos", { headers: auth })).json();
    expect(listed).toMatchObject({ repos: [{ fullName: "Octo/API" }] });
  });

  it("is reviewed for one account only: a second account is refused", async () => {
    const first = await s.signIn(1);
    const second = await s.signIn(2);
    expect((await enroll(first.auth, { platform: "github", fullName: "octo/api" })).status).toBe(
      200,
    );
    const again = await enroll(second.auth, { platform: "github", fullName: "octo/api" });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_body" });
    const theirs = await (await s.call("/api/auto-review/repos", { headers: second.auth })).json();
    expect(theirs).toEqual({ repos: [] });
    // The first account enrolling it again keeps its one row.
    expect((await enroll(first.auth, { platform: "github", fullName: "octo/api" })).status).toBe(
      200,
    );
    expect(await s.host.db.select().from(schema.reviewRepos)).toHaveLength(1);
  });
});

describe("an enrolled repository's review profile", () => {
  it("is balanced until the account picks another, and only the account sees or sets it", async () => {
    const first = await s.signIn(1);
    const second = await s.signIn(2);
    const enrolled = (await (
      await enroll(first.auth, { platform: "github", fullName: "octo/api" })
    ).json()) as { repo: { id: string; profile: string } };
    expect(enrolled.repo.profile).toBe("balanced");
    const path = `/api/auto-review/repos/${enrolled.repo.id}/profile`;
    expect(await (await s.call(path, { headers: first.auth })).json()).toEqual({
      profile: "balanced",
    });

    const set = await s.call(path, {
      method: "PUT",
      headers: first.auth,
      json: { profile: "quiet" },
    });
    expect(await set.json()).toEqual({ profile: "quiet" });
    const listed = await (await s.call("/api/auto-review/repos", { headers: first.auth })).json();
    expect(listed).toMatchObject({ repos: [{ profile: "quiet" }] });

    const wrong = await s.call(path, {
      method: "PUT",
      headers: first.auth,
      json: { profile: "loud" },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_body" });

    const theirs = await s.call(path, {
      method: "PUT",
      headers: second.auth,
      json: { profile: "thorough" },
    });
    expect(theirs.status).toBe(404);
    expect((await s.call(path, { headers: second.auth })).status).toBe(404);

    const [row] = await s.host.db.select().from(schema.reviewRepos);
    expect(row?.reviewProfile).toBe("quiet");

    const id = enrolled.repo.id;
    await s.call(`/api/auto-review/repos/${id}`, { method: "DELETE", headers: second.auth });
    await s.call(`/api/auto-review/repos/${id}`, { method: "DELETE", headers: first.auth });
    const log = async (auth: Record<string, string>) =>
      ((await (await s.call("/api/audit", { headers: auth })).json()) as AuditPage).events;
    expect(auditLines(await log(first.auth))).toEqual(
      lines(
        ["auto_review.unenrolled", { repo: "Octo/API" }],
        ["auto_review.profile_changed", { repo: "Octo/API", profile: "quiet" }],
        ["auto_review.enrolled", { repo: "Octo/API", platform: "github" }],
      ),
    );
    expect(await log(second.auth)).toEqual([]);
  });
});

describe("GitHub's pull request webhook", () => {
  beforeEach(async () => {
    const { auth } = await s.signIn(1);
    await enroll(auth, { platform: "github", fullName: "octo/api" });
  });

  it("queues a head when the pull request opens, once", async () => {
    expect(await (await fromGithub(pullEvent("opened", C1))).json()).toEqual({ queued: 1 });
    expect(await (await fromGithub(pullEvent("opened", C1))).json()).toEqual({ queued: 0 });
    expect(await jobs()).toMatchObject([{ number: 7, head: C1, state: "queued" }]);
  });

  it("supersedes a queued head when the pull request gains commits", async () => {
    await fromGithub(pullEvent("opened", C1));
    await fromGithub(pullEvent("synchronize", C2));
    expect((await jobs()).map((j) => [j.head, j.state])).toEqual([
      [C1, "superseded"],
      [C2, "queued"],
    ]);
  });

  it("skips a draft, a closed or edited pull request, and an unsigned or unknown one", async () => {
    await fromGithub(pullEvent("opened", C1, { draft: true }));
    await fromGithub(pullEvent("closed", C2));
    await fromGithub(pullEvent("edited", C2));
    const other = JSON.stringify({
      ...JSON.parse(pullEvent("opened", C3)),
      repository: { id: 99, full_name: "x/y" },
    });
    expect(await (await fromGithub(other)).json()).toEqual({ queued: 0 });
    const forged = await fromGithub(pullEvent("opened", C3), "pull_request", "sha256=00");
    expect(forged.status).toBe(401);
    expect(await jobs()).toEqual([]);
    // Leaving draft is a review's start.
    expect(await (await fromGithub(pullEvent("ready_for_review", C1))).json()).toEqual({
      queued: 1,
    });
  });

  it("is claimed by one runner, and not again while its review runs", async () => {
    await fromGithub(pullEvent("opened", C1));
    const now = new Date();
    const claimed = await claimJob(s.host.db, now, 60_000);
    expect(claimed).toMatchObject({ number: 7, head: C1, attempts: 1 });
    expect(await claimJob(s.host.db, now, 60_000)).toBeUndefined();
    await fromGithub(pullEvent("synchronize", C2));
    // The newer head waits for the running review of the same pull request.
    expect(await claimJob(s.host.db, now, 60_000)).toBeUndefined();
    const [running] = await s.host.db
      .select()
      .from(schema.reviewJobs)
      .where(eq(schema.reviewJobs.head, C1));
    expect(running?.state).toBe("running");
    // Past the lease the run is taken as dead: the newer head is reviewed, the dead one superseded.
    const later = new Date(now.getTime() + 120_000);
    expect(await claimJob(s.host.db, later, 60_000)).toMatchObject({ head: C2, attempts: 1 });
    expect((await jobs()).map((j) => [j.head, j.state])).toEqual([
      [C1, "superseded"],
      [C2, "running"],
    ]);
  });
});

describe("GitLab's merge request hook", () => {
  it("is proven by the repository's own secret, and queues new commits, not edits", async () => {
    const { auth } = await s.signIn(1);
    const res = await enroll(auth, { platform: "gitlab", fullName: "group/api" });
    const { webhook } = (await res.json()) as { webhook: { url: string; secret: string } };
    expect(webhook.url).toBe(`${ORIGIN}/api/auto-review/webhooks/gitlab`);
    const hook = (attributes: Record<string, unknown>, token = webhook.secret) =>
      s.call("/api/auto-review/webhooks/gitlab", {
        method: "POST",
        headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": token },
        json: {
          object_attributes: { iid: 3, last_commit: { id: C1 }, ...attributes },
          project: { id: 21, path_with_namespace: "group/api" },
        },
      });
    expect((await hook({ action: "open" }, "wrong")).status).toBe(401);
    expect(await (await hook({ action: "open" })).json()).toEqual({ queued: 1 });
    expect(await (await hook({ action: "update" })).json()).toEqual({ queued: 0 });
    expect(
      await (await hook({ action: "update", oldrev: C1, last_commit: { id: C2 } })).json(),
    ).toEqual({
      queued: 1,
    });
    expect(
      await (await hook({ action: "open", draft: true, last_commit: { id: C3 } })).json(),
    ).toEqual({
      queued: 0,
    });
    // GitLab before 15.0 says work_in_progress instead.
    expect(
      await (
        await hook({ action: "open", work_in_progress: true, last_commit: { id: C3 } })
      ).json(),
    ).toEqual({ queued: 0 });
    expect((await jobs()).map((j) => [j.number, j.head, j.state])).toEqual([
      [3, C1, "superseded"],
      [3, C2, "queued"],
    ]);
  });

  it("records a pipeline's delivery only while an intent waits on its commit", async () => {
    const { auth } = await s.signIn(1);
    const res = await enroll(auth, { platform: "gitlab", fullName: "group/api" });
    const { webhook } = (await res.json()) as { webhook: { secret: string } };
    const pipeline = (uuid: string) =>
      s.call("/api/auto-review/webhooks/gitlab", {
        method: "POST",
        headers: {
          "x-gitlab-event": "Pipeline Hook",
          "x-gitlab-token": webhook.secret,
          "x-gitlab-event-uuid": uuid,
        },
        json: {
          object_attributes: { sha: C1, status: "success" },
          project: { id: 21, path_with_namespace: "group/api" },
        },
      });
    const inbound = () => s.host.db.select().from(schema.inboundEvents);
    expect(await (await pipeline("p-0001-aaaa")).json()).toEqual({ queued: 0 });
    expect(await inbound()).toEqual([]);
    const [repo] = await s.host.db.select().from(schema.reviewRepos);
    await scoped(s.host.db, repo?.accountId ?? "").insert("mergeIntents", {
      platform: "gitlab",
      host: repo?.host ?? "",
      fullName: "group/api",
      number: 3,
      method: "merge",
      mode: "native",
      head: C1,
      state: "armed",
      armedBy: "octo",
    });
    expect(await (await pipeline("p-0002-aaaa")).json()).toEqual({ queued: 0 });
    expect(await (await pipeline("p-0002-aaaa")).json()).toEqual({ queued: 0, duplicate: true });
    expect(await inbound()).toMatchObject([{ event: "Pipeline Hook", deliveryId: "p-0002-aaaa" }]);
  });
});
