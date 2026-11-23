import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import type { Scoped } from "../src/db/scoped.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { C1, C2, GITLAB } from "./graph-fakes.js";
import { graphServer, SECRET, type Server } from "./graph-server.js";

// The repository's own CI failing on a pull request's head tells its author,
// in the channels that hear about checks_failed, once per head, from the
// delivery alone: GitHub's check suite of another App than ocra's, GitLab's
// merge request pipeline.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-ci-failed-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const APP_ID = 4242;

let s: Server;
let chats: string[];
let platformCalls: string[];

beforeEach(async () => {
  s = await graphServer(dir, `ci-failed-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api, githubAppId: String(APP_ID) },
    workers: 0,
  });
  chats = [];
  platformCalls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = req.url;
    if (url.startsWith("https://hooks.slack.com/")) {
      chats.push(((await req.json()) as { text: string }).text);
      return new Response("ok");
    }
    platformCalls.push(url);
    if (url.toLowerCase() === "https://api.github.com/repos/octo/api") {
      return Response.json({ id: 11, full_name: "Octo/API", default_branch: "main" });
    }
    if (url.toLowerCase() === "https://api.github.com/repos/octo/api/branches/main") {
      return Response.json({ commit: { sha: C1 } });
    }
    const lab = `${GITLAB}/api/v4/projects/`;
    if (url === `${lab}group%2Fapi`) {
      return Response.json({ id: 21, path_with_namespace: "group/api", default_branch: "main" });
    }
    if (url === `${lab}21/repository/branches/main`) return Response.json({ commit: { id: C1 } });
    return new Response(null, { status: 404 });
  });
});
afterEach(() => s.host.close());

/** The signed-in user 1, its enrolled repository, and a channel that hears about events. */
async function me(platform: "github" | "gitlab", events = ["checks_failed"]) {
  const user = await s.signIn(1);
  const fullName = platform === "github" ? "octo/api" : "group/api";
  const res = await s.call("/api/auto-review/repos", {
    method: "POST",
    headers: user.auth,
    json: { platform, fullName },
  });
  expect(res.status).toBe(200);
  const { webhook } = (await res.json()) as { webhook?: { secret: string } };
  const added = await s.call("/api/notifications/channels", {
    method: "POST",
    headers: user.auth,
    json: { kind: "slack", url: SLACK, name: "team", when: "blocking", events },
  });
  expect(added.status).toBe(200);
  const [repo] = await s.host.db.select().from(schema.reviewRepos);
  if (!repo) throw new Error("not enrolled");
  return { ...user, repo, secret: webhook?.secret ?? "" };
}

async function pullBy(data: Scoped, repoId: string, number: number, authorId: string) {
  await data.pullFlows.record({
    reviewRepoId: repoId,
    number,
    title: "Add the <!channel> cache",
    author: "mona",
    authorId,
    draft: false,
    size: null,
    seenAt: new Date(),
  });
}

async function deliver(event: string, payload: Record<string, unknown>, id: string) {
  const body = JSON.stringify({ ...payload, repository: { id: 11, full_name: "Octo/API" } });
  const res = await s.call("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": id,
      "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
    },
    body,
  });
  expect(res.status).toBe(202);
}

const suite = (head: string, conclusion: string, app = 1, pulls = [{ number: 7, head }]) => ({
  action: "completed",
  check_suite: {
    head_sha: head,
    conclusion,
    app: { id: app, name: "CI" },
    pull_requests: pulls.map((p) => ({ number: p.number, head: { sha: p.head } })),
  },
});

const inbound = () => s.host.db.select().from(schema.inboundEvents);
/** Lets the webhooks' work after the answer finish. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("CI failing on a GitHub pull request", () => {
  it("tells its author once per head, and a later green run on it nothing", async () => {
    const { data, repo } = await me("github");
    await pullBy(data, repo.id, 7, "1");
    const calls = platformCalls.length;
    await deliver("check_suite", suite(C1, "failure"), "d-1");
    await settle();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toContain("CI failed on your pull request");
    // The platform's title is plain text in the notice, never a chat's mention.
    expect(chats[0]).not.toContain("<!channel>");
    // Another failed suite and a green one on the same head tell nothing more.
    await deliver("check_suite", suite(C1, "timed_out"), "d-2");
    await deliver("check_suite", suite(C1, "success"), "d-3");
    await settle();
    expect(chats).toHaveLength(1);
    // A new head that fails is told again.
    await deliver("check_suite", suite(C2, "startup_failure"), "d-4");
    await settle();
    expect(chats).toHaveLength(2);
    expect(platformCalls.length).toBe(calls);
  });

  it("skips ocra's own App's suite, other authors, closed pulls and moved heads", async () => {
    const { data, repo } = await me("github");
    await pullBy(data, repo.id, 7, "1");
    await pullBy(data, repo.id, 8, "99");
    await pullBy(data, repo.id, 9, "1");
    await data.insert("closedPulls", {
      reviewRepoId: repo.id,
      number: 9,
      title: "T",
      merged: false,
      closedAt: new Date(),
    });
    await deliver("check_suite", suite(C1, "failure", APP_ID), "o-0001-aaaa");
    await deliver("check_suite", suite(C1, "failure", 1, [{ number: 8, head: C1 }]), "o-0002-aaaa");
    await deliver("check_suite", suite(C1, "failure", 1, [{ number: 9, head: C1 }]), "o-0003-aaaa");
    await deliver("check_suite", suite(C1, "failure", 1, [{ number: 7, head: C2 }]), "o-0004-aaaa");
    await deliver("check_suite", suite(C1, "cancelled"), "o-0005-aaaa");
    await settle();
    expect(chats).toEqual([]);
    // ocra's own suite, a moved head and a cancelled run keep no record; the others are read.
    expect((await inbound()).map((e) => e.deliveryId).sort()).toEqual([
      "o-0002-aaaa",
      "o-0003-aaaa",
    ]);
  });

  it("tells nobody whose channels do not hear about checks_failed", async () => {
    const { data, repo } = await me("github", ["pull_closed"]);
    await pullBy(data, repo.id, 7, "1");
    await deliver("check_suite", suite(C1, "failure"), "n-1");
    await settle();
    expect(chats).toEqual([]);
  });
});

describe("a GitLab merge request pipeline that fails", () => {
  it("tells the merge request's author once per head", async () => {
    const { data, repo, secret } = await me("gitlab");
    // The GitLab user the link signed in as.
    await s.host.db
      .update(schema.platformLinks)
      .set({ userId: "501", login: "mona" })
      .where(eq(schema.platformLinks.platform, "gitlab"));
    await pullBy(data, repo.id, 5, "501");
    const pipeline = (sha: string, status: string, state = "opened") =>
      s.call("/api/auto-review/webhooks/gitlab", {
        method: "POST",
        headers: { "x-gitlab-event": "Pipeline Hook", "x-gitlab-token": secret },
        json: {
          object_attributes: { sha, status },
          merge_request: { iid: 5, state },
          project: { id: 21, path_with_namespace: "group/api" },
        },
      });
    expect((await pipeline(C1, "failed")).status).toBe(202);
    await settle();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toContain("CI failed on your merge request");
    await pipeline(C1, "failed");
    await pipeline(C1, "success");
    await pipeline(C2, "failed", "merged");
    await settle();
    expect(chats).toHaveLength(1);
    await pipeline(C2, "failed");
    await settle();
    expect(chats).toHaveLength(2);
  });
});
