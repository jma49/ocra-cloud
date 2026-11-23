import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { hmacHex } from "../src/crypto.js";
import { claimInboundRetry, finishInbound, receiveInbound } from "../src/db/inbound-events.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { githubFields } from "../src/inbound/fields.js";
import { MAX_INBOUND_ATTEMPTS, retryInbound } from "../src/inbound/run.js";
import { githubCommentEvents } from "../src/notify/comment-hooks.js";
import { githubPullEvents } from "../src/notify/pull-hooks.js";
import type { BotTokens } from "../src/platforms/bot.js";
import { db, request, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// A platform's webhook delivery is acted on once, however often it is
// delivered, and what runs after its answer is tried again when it fails,
// by one sweeper at a time, from a row that keeps only the fields it reads.

const SECRET = "inbound-test-secret";
const HEAD = "c".repeat(40);

beforeEach(async () => {
  await resetDb();
  await db.delete(schema.inboundEvents);
});
afterEach(() => vi.restoreAllMocks());

/** A bot whose token is asked for each time a reviewed pull request's directories are read. */
function bot(fail = 0) {
  const asked: string[] = [];
  const bots = {
    async forRepo(_platform: string, fullName: string) {
      asked.push(fullName);
      if (asked.length <= fail) throw new Error("bot token store unavailable");
      return { token: "bot-token" };
    },
  } as unknown as BotTokens;
  return { bots, asked };
}

function appWith(bots: BotTokens) {
  const app = createApp({
    openDb: (e: Env) => drizzle(e.DB),
    clientAddress: () => "192.0.2.1",
    githubWebhookSecret: SECRET,
    bots,
  });
  return async (body: string, headers: Record<string, string>) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      request("/api/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
          ...headers,
        },
      }),
      env,
      ctx,
    );
    const answer = await res.json();
    await waitOnExecutionContext(ctx);
    return { status: res.status, answer };
  };
}

/** The platform's pull request, its files listed; how often it was read. */
function github(files: () => Response) {
  const reads: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    reads.push(url);
    if (url.endsWith("/pulls/7")) {
      return Response.json({
        changed_files: 1,
        base: { sha: "0".repeat(40) },
        head: { sha: HEAD },
      });
    }
    return url.includes("/pulls/7/files") ? files() : new Response("{}", { status: 404 });
  });
  return reads;
}

async function enrolled() {
  const { account } = await signIn(1, "octo");
  const data = scoped(db, account.id);
  await data.insert("reviewRepos", {
    ...rows.reviewRepos("repo-1"),
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "octo/api",
  });
  return data;
}

const reviewed = JSON.stringify({
  action: "submitted",
  review: { id: 900, user: { id: 7, login: "hubot", type: "User" }, state: "approved" },
  pull_request: {
    number: 7,
    title: "Add a cache",
    body: "A description with code: const key = 'sk-live-should-not-be-kept'",
    user: { id: 42, login: "mona", type: "User" },
    head: { sha: HEAD },
  },
  repository: { id: 11, full_name: "octo/api" },
});

const events = () => db.select().from(schema.inboundEvents);

describe("a platform's delivery", () => {
  it("runs its side effects once, however often it is delivered", async () => {
    await enrolled();
    // The platform does not list the files: nothing is kept, so only a second run would ask again.
    const reads = github(() => new Response("busy", { status: 503 }));
    const hook = appWith(bot().bots);
    const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "d-0001-aaaa" };
    expect(await hook(reviewed, headers)).toEqual({ status: 202, answer: { queued: 0 } });
    const first = reads.length;
    expect(first).toBeGreaterThan(0);
    expect(await hook(reviewed, headers)).toEqual({
      status: 202,
      answer: { queued: 0, duplicate: true },
    });
    expect(reads).toHaveLength(first);
    const [row] = await events();
    expect(row).toMatchObject({ deliveryId: "d-0001-aaaa", state: "done", work: null });
    expect(await events()).toHaveLength(1);
  });

  it("takes another delivery of the same event, with its own id, as a new one", async () => {
    await enrolled();
    github(() => new Response("busy", { status: 503 }));
    const hook = appWith(bot().bots);
    for (const id of ["d-0002-aaaa", "d-0002-bbbb"]) {
      const res = await hook(reviewed, {
        "x-github-event": "pull_request_review",
        "x-github-delivery": id,
      });
      expect(res.answer).toEqual({ queued: 0 });
    }
    expect(await events()).toHaveLength(2);
  });

  it("tries a side effect that failed again, and only that one, until it succeeds", async () => {
    const data = await enrolled();
    github(() => Response.json([{ filename: "src/db/a.ts", status: "modified" }]));
    const { bots, asked } = bot(1);
    const hook = appWith(bots);
    await hook(reviewed, {
      "x-github-event": "pull_request_review",
      "x-github-delivery": "d-0003-aaaa",
    });
    expect(asked).toHaveLength(1);
    expect(await data.list("pullPaths")).toEqual([]);
    const [pending] = await events();
    expect(pending).toMatchObject({ state: "pending", attempts: 1 });
    expect(JSON.stringify(pending?.work)).not.toContain("sk-live");
    expect(pending?.work).toMatchObject({ steps: ["paths"] });

    const runner = { db, env, bots };
    // Not due yet.
    expect(await retryInbound(runner)).toBe(0);
    const later = () => new Date(Date.now() + 61_000);
    expect(await retryInbound(runner, later)).toBe(1);
    expect(asked).toHaveLength(2);
    expect((await data.list("pullPaths")).map((p) => p.prefix).sort()).toEqual(["src", "src/db"]);
    expect(await events()).toMatchObject([{ state: "done", attempts: 2, work: null }]);
    expect(await retryInbound(runner, later)).toBe(0);
  });

  it("gives up after MAX_INBOUND_ATTEMPTS, its work dropped", async () => {
    await enrolled();
    github(() => Response.json([]));
    const { bots, asked } = bot(Number.POSITIVE_INFINITY);
    await appWith(bots)(reviewed, {
      "x-github-event": "pull_request_review",
      "x-github-delivery": "d-0004-aaaa",
    });
    let at = Date.now();
    for (let i = 1; i < MAX_INBOUND_ATTEMPTS; i++) {
      at += 3 * 60 * 60_000;
      expect(await retryInbound({ db, env, bots }, () => new Date(at))).toBe(1);
    }
    expect(asked).toHaveLength(MAX_INBOUND_ATTEMPTS);
    expect(await events()).toMatchObject([
      { state: "failed", attempts: MAX_INBOUND_ATTEMPTS, work: null },
    ]);
  });
});

describe("the retry sweep", () => {
  async function due(id: string, repo: string) {
    const past = new Date(Date.now() - 1000);
    await receiveInbound(db, {
      id,
      platform: "github",
      host: "github.com",
      deliveryId: id,
      event: "pull_request_review",
      repo,
      work: { origin: "https://ocra.test", steps: ["paths"], reviewed: { number: 7, head: HEAD } },
      leaseUntil: past,
    });
  }

  it("lets two sweepers run one delivery once", async () => {
    await enrolled();
    github(() => Response.json([{ filename: "a/b.ts", status: "modified" }]));
    await due("e-1", "11");
    const { bots, asked } = bot();
    const runner = { db, env, bots };
    const tried = await Promise.all([retryInbound(runner), retryInbound(runner)]);
    expect(tried.sort()).toEqual([0, 1]);
    expect(asked).toHaveLength(1);
    expect(await events()).toMatchObject([{ state: "done", attempts: 2 }]);
  });

  it("leaves a delivery whose lease has not ended to the runner that holds it", async () => {
    await receiveInbound(db, {
      id: "held",
      platform: "github",
      host: "github.com",
      deliveryId: "held",
      event: "pull_request",
      repo: "11",
      work: { origin: "https://ocra.test", steps: ["tell"] },
      leaseUntil: new Date(Date.now() + 60_000),
    });
    expect(await claimInboundRetry(db, new Date(), 60_000)).toBeUndefined();
    expect(await claimInboundRetry(db, new Date(Date.now() + 61_000), 60_000)).toMatchObject({
      id: "held",
      attempts: 2,
    });
  });

  it("claims an attempt by compare-and-set: of two claims, one wins", async () => {
    await due("e-2", "11");
    const now = new Date();
    const claims = await Promise.all([
      claimInboundRetry(db, now, 60_000),
      claimInboundRetry(db, now, 60_000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    // The loser's late finish changes nothing.
    expect(await finishInbound(db, "e-2", 1, { state: "done" })).toBe(false);
  });

  it("takes repositories in turn, so one with many due does not starve another", async () => {
    for (const id of ["a-1", "a-2", "a-3"]) await due(id, "1");
    await due("b-1", "2");
    const now = new Date();
    const first = await claimInboundRetry(db, now, 60_000);
    const second = await claimInboundRetry(db, now, 60_000, [first?.repo ?? ""]);
    expect([first?.repo, second?.repo]).toEqual(["1", "2"]);
  });
});

describe("a delivery's kept fields", () => {
  it("are those its side effects read, and nothing else", () => {
    const comment = {
      action: "created",
      pull_request: { number: 5, title: "Cache", body: "secret description" },
      comment: {
        id: 77,
        body: "@mona have a look",
        diff_hunk: "@@ -1 +1 @@\n-const a = 1\n+const a = 'sk-live-xyz'",
        user: { id: 7, login: "hubot", type: "User" },
        in_reply_to_id: 70,
      },
      repository: { id: 11, full_name: "octo/api", private: true },
      installation: { id: 99 },
    };
    const kept = githubFields(comment);
    expect(JSON.stringify(kept)).not.toMatch(/sk-live|secret description|installation|private/);
    for (const [event, body] of [
      ["pull_request_review_comment", comment],
      ["pull_request_review", JSON.parse(reviewed)],
    ] as const) {
      const projected = githubFields(body);
      expect(githubCommentEvents(event, projected, "r")).toEqual(
        githubCommentEvents(event, body, "r"),
      );
      expect(githubPullEvents(event, projected, "r")).toEqual(githubPullEvents(event, body, "r"));
    }
  });
});
