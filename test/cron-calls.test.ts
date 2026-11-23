import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import worker from "../src/index.js";
import { saveToken } from "../src/platforms/links.js";
import { platformsOf } from "../src/platforms/registry.js";
import { call, db, ORIGIN, resetDb, signIn } from "./helpers.js";
import { GITLAB } from "./platform-fakes.js";
import { rows } from "./table-rows.js";

// The Worker's scheduled run within one budget of external calls (the Free
// plan fails an invocation past 50): every job, loaded past its share,
// still makes no more than WORKER_CALLS in all, and what a run left is
// done by the next, each message sent once.

beforeEach(resetDb);

/** WORKER_CALLS (src/cron-calls.ts): the Free plan's 50 subrequests, with room to spare. */
const WORKER_CALLS = 45;
afterEach(() => vi.restoreAllMocks());

const DAY = 24 * 60 * 60_000;
const chatUrl = (job: string) => `https://hooks.slack.com/services/T000/${job}/XXXXsecret`;

/** Every outside call, by the job its address says made it; chat bodies by job. */
function outside() {
  const byJob: Record<string, number> = {};
  const bodies: Record<string, string[]> = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const chat = url.pathname.match(/^\/services\/T000\/([^/]+)\//)?.[1];
    // A merge request read on its own is the inbound retry's; GitHub's GraphQL, a stack's layer.
    const job =
      chat ??
      (url.origin === GITLAB && /\/merge_requests\/\d+/.test(url.pathname)
        ? "inbound"
        : url.pathname === "/graphql"
          ? "stackMerges"
          : url.origin === GITLAB || url.pathname.startsWith("/repos/")
            ? "reconcile"
            : "other");
    byJob[job] = (byJob[job] ?? 0) + 1;
    if (chat) {
      const body = await req.text();
      const list = bodies[chat] ?? [];
      list.push(body);
      bodies[chat] = list;
      return new Response("ok");
    }
    return Response.json([]);
  });
  return {
    byJob,
    bodies,
    total: () => Object.values(byJob).reduce((a, b) => a + b, 0),
  };
}

async function hourly() {
  const ctx = createExecutionContext();
  // The notices' links need PUBLIC_URL, which wrangler.jsonc sets and the Postgres project's env does not.
  const hosted = { ...env, PUBLIC_URL: "https://app.ocracloud.com" };
  await worker.scheduled(createScheduledController({ cron: "47 * * * *" }), hosted, ctx);
  await waitOnExecutionContext(ctx);
}

const [github, gitlab] = (() => {
  const all = platformsOf(env, ORIGIN);
  return [all.find((p) => p.kind === "github"), all.find((p) => p.kind === "gitlab")];
})();

/** An account linked to both platforms, with a chat channel for `job`. */
async function account(n: number, job: string, channel: Record<string, unknown> = {}) {
  const me = await signIn(n, `user-${n}`);
  const data = scoped(db, me.account.id);
  for (const p of [github, gitlab]) {
    if (p) await saveToken(data, env, p, { access_token: `token-${n}-${p.kind}` });
  }
  const res = await call("/api/notifications/channels", {
    method: "POST",
    auth: me.auth,
    json: { kind: "slack", name: job, when: "every", url: chatUrl(job), ...channel },
  });
  expect(res.status).toBe(200);
  const channelId = ((await res.json()) as { channel: { id: string } }).channel.id;
  return { id: me.account.id, channelId };
}

/** Deliveries due again, each its own body. */
async function dueDeliveries(n: number, count: number) {
  const a = await account(n, "deliveries");
  for (let i = 0; i < count; i++) {
    await db.insert(schema.notifyDeliveries).values({
      ...rows.notifyDeliveries(`delivery-${n}-${i}`),
      accountId: a.id,
      channelId: a.channelId,
      state: "pending",
      payload: `{"delivery":${i}}`,
      retryAt: new Date(Date.now() - 60_000),
    });
  }
}

/** Accounts with a review yesterday and a channel that takes their digest. */
async function digestsDue(from: number, count: number) {
  for (let n = from; n < from + count; n++) {
    const a = await account(n, "digests", { digest: true });
    await db.insert(schema.reviews).values({
      ...rows.reviews(`review-${n}`),
      accountId: a.id,
      createdAt: new Date(Date.now() - DAY),
    });
  }
}

/** Every job of the hourly run with more work than its share. */
async function loadEveryJob() {
  await dueDeliveries(1, 60);
  await digestsDue(10, 8);
  for (let n = 20; n < 26; n++) {
    const a = await account(n, "held");
    await db
      .update(schema.notifyChannels)
      .set({ events: ["pull_commented"] })
      .where(eq(schema.notifyChannels.id, a.channelId));
    await db.insert(schema.notifyHeld).values({
      ...rows.notifyHeld(`held-${n}`),
      accountId: a.id,
      channelId: a.channelId,
    });
  }
  const owner = await account(30, "repos");
  for (let i = 0; i < 30; i++) {
    // GitLab merge requests whose reviewed directories are read again.
    const repoId = `gl-${i}`;
    await db.insert(schema.reviewRepos).values({
      ...rows.reviewRepos(repoId),
      accountId: owner.id,
      platform: "gitlab",
      host: new URL(GITLAB).host,
      platformRepoId: repoId,
      fullName: `group/gl-${i}`,
    });
    await db.insert(schema.inboundEvents).values({
      id: `inbound-${i}`,
      platform: "gitlab",
      host: new URL(GITLAB).host,
      deliveryId: `d-${i}`,
      event: "Merge Request Hook",
      repo: repoId,
      work: { origin: ORIGIN, steps: ["paths"], reviewed: { number: 1, head: "b".repeat(40) } },
      retryAt: new Date(Date.now() - 60_000),
    });
  }
  for (let i = 0; i < 20; i++) {
    await db.insert(schema.stackMerges).values({
      ...rows.stackMerges(`stack-${i}`),
      accountId: owner.id,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
  }
  for (let i = 0; i < 10; i++) {
    await db.insert(schema.reviewRepos).values({
      ...rows.reviewRepos(`gh-${i}`),
      accountId: (await signIn(40 + i, `repo-owner-${i}`)).account.id,
      platform: "github",
      host: "github.com",
      fullName: `org/r${i}`,
      createdAt: new Date(Date.now() - DAY),
    });
  }
}

describe("the scheduled run's calls", () => {
  it("never passes the budget with every job loaded, and each job gets calls", async () => {
    await loadEveryJob();
    // Accounts whose repositories reconcile need a link of their own.
    for (const row of await db.select().from(schema.reviewRepos)) {
      if (row.platform === "github" && github) {
        await saveToken(scoped(db, row.accountId), env, github, { access_token: "t" });
      }
    }
    const seen = outside();
    await hourly();
    expect(seen.total()).toBeLessThanOrEqual(WORKER_CALLS);
    for (const job of ["deliveries", "digests", "held", "inbound", "stackMerges", "reconcile"]) {
      expect(seen.byJob[job], job).toBeGreaterThan(0);
    }
    expect(seen.byJob.other).toBeUndefined();
  });

  it("leaves what a run could not reach to the next, each message sent once", async () => {
    await dueDeliveries(1, 60);
    await digestsDue(10, 10);
    const seen = outside();
    await hourly();
    expect(seen.total()).toBeLessThanOrEqual(WORKER_CALLS);
    const first = seen.bodies.deliveries?.length ?? 0;
    expect(first).toBeLessThan(60);

    for (let run = 0; run < 3; run++) await hourly();
    const sent = seen.bodies.deliveries ?? [];
    expect(sent).toHaveLength(60);
    expect(new Set(sent).size).toBe(60);
    const digests = seen.bodies.digests ?? [];
    expect(digests).toHaveLength(10);
    const pending = await db
      .select()
      .from(schema.notifyDeliveries)
      .where(eq(schema.notifyDeliveries.state, "pending"));
    expect(pending).toEqual([]);
  });
});
