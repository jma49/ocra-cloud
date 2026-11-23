import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { asc } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import type { AutomationAction } from "../src/shared/index.js";
import { db, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// A Worker with the GitHub App's key has a bot, so an automation rule's
// write the platform did not answer is queued there too: the hourly run
// tries it again, within the run's budget of calls, and an attempt the
// budget cut short is given back uncounted.

/** WORKER_CALLS (src/cron-calls.ts). */
const WORKER_CALLS = 45;
const REMOTE = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "RUNNER_TOKEN"];
const vars = env as unknown as Record<string, string | undefined>;

let worker: typeof import("../src/index.js").default;

beforeAll(async () => {
  const RSA = {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  };
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  vars.GITHUB_APP_ID = "42";
  vars.GITHUB_APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  vars.GITHUB_WEBHOOK_SECRET = "hook-secret";
  vars.RUNNER_TOKEN = "runner-token-of-at-least-32-characters";
  // The Worker reads its bot's settings once, when its module loads.
  vi.resetModules();
  worker = (await import("../src/index.js")).default;
});
afterAll(() => {
  for (const name of REMOTE) delete vars[name];
  vi.resetModules();
});
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** GitHub as the App's bot sees it; the writes sent, by path, and the calls made. */
function github(answers: { labels?: () => Response } = {}) {
  const writes: string[] = [];
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const { pathname } = new URL(req.url);
    calls++;
    if (pathname === "/app") return Response.json({ slug: "ocra" });
    if (pathname.endsWith("/installation")) return Response.json({ id: 7 });
    if (pathname === "/app/installations/7/access_tokens") {
      return Response.json({ token: "ghs_bot" }, { status: 201 });
    }
    if (req.method === "POST" && /\/issues\/\d+\/(labels|comments)$/.test(pathname)) {
      writes.push(pathname);
      return pathname.endsWith("/labels") && answers.labels
        ? answers.labels()
        : Response.json({}, { status: pathname.endsWith("/labels") ? 200 : 201 });
    }
    return new Response(null, { status: 404 });
  });
  return { writes, calls: () => calls };
}

async function hourly() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "47 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

const LABEL: AutomationAction = { kind: "add_labels", labels: ["needs-review"] };
const COMMENT: AutomationAction = { kind: "comment", body: "Thanks" };

/** `count` runs of an enrolled repository whose writes the platform did not answer, due again. */
async function unanswered(count: number, actions: AutomationAction[] = [LABEL]) {
  const me = await signIn(1, "octo");
  await db.insert(schema.reviewRepos).values({
    ...rows.reviewRepos("repo"),
    accountId: me.account.id,
    fullName: "octo/api",
    // Read today already: the run's reconciliation leaves it alone.
    reconciledAt: new Date(),
  });
  for (let i = 0; i < count; i++) {
    await db.insert(schema.automationRuns).values({
      ...rows.automationRuns(`run-${String(i).padStart(2, "0")}`),
      accountId: me.account.id,
      outcome: "failed",
      attempts: 1,
      actions: actions.map((a) => ({ kind: a.kind, outcome: "unreached" as const })),
      retry: {
        reviewRepoId: "repo",
        number: i + 1,
        actions: actions.map((action, index) => ({ index, action })),
      },
      retryAt: new Date(Date.now() - 60_000 - i * 1000),
    });
  }
}

const runs = () => db.select().from(schema.automationRuns).orderBy(asc(schema.automationRuns.id));

describe("the hourly run's retries of the automation rules' writes", () => {
  it("sends again, as the bot, a write the platform did not answer", async () => {
    await unanswered(1);
    const seen = github();
    await hourly();
    expect(seen.writes).toEqual(["/repos/octo/api/issues/1/labels"]);
    expect(await runs()).toMatchObject([
      {
        outcome: "done",
        attempts: 2,
        actions: [{ kind: "add_labels", outcome: "done" }],
        retry: null,
        retryAt: null,
      },
    ]);
    await hourly();
    expect(seen.writes).toHaveLength(1);
  });

  it("backs off a write that is still unanswered, and stops after the last attempt", async () => {
    await unanswered(1);
    const seen = github({ labels: () => new Response(null, { status: 502 }) });
    await hourly();
    const [again] = await runs();
    expect(again).toMatchObject({ outcome: "failed", attempts: 2 });
    expect(again?.retryAt?.getTime()).toBeGreaterThan(Date.now());
    await db.update(schema.automationRuns).set({ retryAt: new Date(0) });
    await hourly();
    expect(await runs()).toMatchObject([
      { outcome: "failed", attempts: 3, retry: null, retryAt: null },
    ]);
    await hourly();
    expect(seen.writes).toHaveLength(2);
  });

  it("stays within the run's calls, and leaves the rest due, their attempts uncounted", async () => {
    await unanswered(20, [LABEL, COMMENT]);
    const seen = github();
    await hourly();
    expect(seen.calls()).toBeLessThanOrEqual(WORKER_CALLS);
    const after = await runs();
    const done = after.filter((r) => r.outcome === "done");
    expect(done.length).toBeGreaterThan(0);
    expect(done.length).toBeLessThan(20);
    for (const r of after.filter((x) => x.outcome !== "done")) {
      expect(r, r.id).toMatchObject({ attempts: 1, retry: { reviewRepoId: "repo" } });
      expect(r.retryAt?.getTime(), r.id).toBeLessThanOrEqual(Date.now());
    }
    // No write is recorded as refused or done that was not sent, and none is sent twice.
    const answered = after.flatMap((r) => r.actions).filter((a) => a.outcome === "done").length;
    expect(seen.writes).toHaveLength(answered);
    expect(after.flatMap((r) => r.actions).every((a) => /^(done|unreached)$/.test(a.outcome))).toBe(
      true,
    );
    for (let run = 0; run < 6; run++) await hourly();
    expect((await runs()).every((r) => r.outcome === "done" && r.attempts === 2)).toBe(true);
    expect(seen.writes).toHaveLength(40);
    expect(new Set(seen.writes).size).toBe(40);
  });
});
