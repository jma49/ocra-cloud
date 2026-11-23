import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign } from "../src/auto-review/work.js";
import { claimJob } from "../src/db/review-jobs.js";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import { digestOf, statusOf } from "../src/merge-checks/run.js";
import type { Outbox } from "../src/notify/notify.js";
import { tellSpend } from "../src/notify/spend.js";
import type { MergeChecksReportView, SpendView } from "../src/shared/index.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";

// The account's spend limit: the cost each uploaded review reports is
// counted once, an account at its daily or monthly limit has no hosted
// review started until the window turns or the limit is raised, and it is
// told once when it nears the limit and once when it reaches it.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const CALLS = 1000;
const A = "a".repeat(40);
const now = new Date("2026-03-04T10:00:00Z");
const nextDay = new Date("2026-03-05T00:00:00Z");
const nextMonth = new Date("2026-04-01T00:00:00Z");

const upload = (runId: string, costUsd: number) => ({
  runId,
  repoHash: "d".repeat(64),
  source: "local",
  findings: { critical: 0, warning: 0, suggestion: 0 },
  usage: { inputTokens: 10, outputTokens: 5, costUsd },
});

const spendOf = async (auth: { authorization: string }) =>
  ((await (await call("/api/budget", { auth })).json()) as { spend: SpendView }).spend;

async function queued(githubId = 1, platformRepoId = "11") {
  const accountId = (await signIn(githubId, `u${githubId}`)).account.id;
  const data = scoped(db, accountId);
  const id =
    (await data.autoReview.enroll(
      { platform: "github", host: "github.com", platformRepoId, fullName: "octo/api" },
      100,
    )) ?? "";
  await data.autoReview.queue(id, 7, A, now);
  return { data, accountId };
}

const spend = (data: ReturnType<typeof scoped>, usd: number, at: Date) =>
  data.insert("usageCounters", {
    kind: "spend",
    day: at.toISOString().slice(0, 10),
    n: Math.round(usd * 1_000_000),
  });

describe("what an account's reviews cost", () => {
  it("counts a stored review's cost once, a retry of its run not again", async () => {
    const cli = await signInCli(1, "octo");
    const web = await signIn(1, "octo");
    const post = (run: string, cost: number) =>
      call("/api/reviews", { method: "POST", auth: cli.auth, json: upload(run, cost) });
    expect((await post("a", 1.25)).status).toBe(200);
    expect((await post("a", 1.25)).status).toBe(200);
    expect((await post("b", 0.5)).status).toBe(200);
    expect((await post("c", 0)).status).toBe(200);
    expect(await spendOf(web.auth)).toMatchObject({
      dailyUsd: null,
      monthlyUsd: null,
      spentTodayUsd: 1.75,
      spentMonthUsd: 1.75,
      defaults: { dailyUsd: 10, monthlyUsd: 100 },
    });
  });

  it("saves the account's own limits, and refuses one that is not an amount", async () => {
    const { auth, account } = await signIn(1, "octo");
    const put = (json: unknown) => call("/api/budget/spend", { method: "PUT", auth, json });
    expect((await put({ dailyUsd: 0.001, monthlyUsd: null })).status).toBe(400);
    expect((await put({ dailyUsd: 2.5, monthlyUsd: null })).status).toBe(200);
    expect(await spendOf(auth)).toMatchObject({ dailyUsd: 2.5, monthlyUsd: null });
    const events = await scoped(db, account.id).listNewest("auditEvents", 10);
    expect(events.map((e) => [e.kind, e.detail])).toContainEqual([
      "budget.spend_changed",
      { dailyUsd: 2.5, monthlyUsd: null },
    ]);
  });
});

describe("an account at a spend limit", () => {
  it("has no review started at the default daily limit until the day turns", async () => {
    const { data } = await queued();
    await spend(data, 10, now);
    // Another account's reviews are not held back by it.
    const other = await queued(2, "12");
    expect(await claimJob(db, now, 60_000, CALLS)).toMatchObject({ accountId: other.accountId });
    expect(await claimJob(db, now, 60_000, CALLS)).toBeUndefined();
    expect(await claimJob(db, nextDay, 60_000, CALLS)).toMatchObject({ number: 7 });
  });

  it("starts again once the limit is raised", async () => {
    const { data } = await queued();
    await spend(data, 10, now);
    expect(await claimJob(db, now, 60_000, CALLS)).toBeUndefined();
    await data.batch((w) => [w.upsert("budgets", { dailyUsd: 20 }, ["accountId"])]);
    expect(await claimJob(db, now, 60_000, CALLS)).toMatchObject({ number: 7 });
  });

  it("starts work past the defaults once the account turns its limits off", async () => {
    const { data } = await queued();
    await spend(data, 150, now);
    await data.batch((w) => [w.upsert("budgets", { dailyUsd: 0 }, ["accountId"])]);
    // The monthly default still holds.
    expect(await claimJob(db, now, 60_000, CALLS)).toBeUndefined();
    await data.batch((w) => [w.upsert("budgets", { monthlyUsd: 0 }, ["accountId"])]);
    expect(await claimJob(db, now, 60_000, CALLS)).toMatchObject({ number: 7 });
  });

  it("waits at the monthly limit through the month's days, until the month turns", async () => {
    const { data } = await queued();
    await data.batch((w) => [w.upsert("budgets", { monthlyUsd: 3 }, ["accountId"])]);
    await spend(data, 3, new Date("2026-03-01T00:00:00Z"));
    expect(await claimJob(db, now, 60_000, CALLS)).toBeUndefined();
    expect(await claimJob(db, nextDay, 60_000, CALLS)).toBeUndefined();
    expect(await claimJob(db, nextMonth, 60_000, CALLS)).toMatchObject({ number: 7 });
  });
});

describe("a hosted review's own limit", () => {
  const source = {
    db,
    platforms: [{ kind: "github", host: "github.com", url: "https://github.com" }] as never,
    bots: { forRepo: async () => ({ token: "t", login: "ocra[bot]" }) } as never,
    publicUrl: "https://ocra.test",
    dailyCalls: CALLS,
    now: () => now,
  };
  const capOf = async () => {
    const work = await assign(source, "review");
    return work && work !== "refused" ? work.config.maxCostUsd : work;
  };

  it("is what is left before the nearer limit", async () => {
    const { data } = await queued();
    await data.batch((w) => [w.upsert("budgets", { monthlyUsd: 9.75 }, ["accountId"])]);
    await spend(data, 9.6, now);
    expect(await capOf()).toBe(0.15);
  });

  it("is the account's limit per review where that is less", async () => {
    const { data } = await queued();
    await spend(data, 9.6, now);
    await data.batch((w) => [
      w.upsert("preferences", { settings: { maxCostUsd: 0.25 } }, ["accountId"]),
    ]);
    expect(await capOf()).toBe(0.25);
  });

  it("is none with both spend limits off and no limit per review", async () => {
    const { data } = await queued();
    await data.batch((w) => [w.upsert("budgets", { dailyUsd: 0, monthlyUsd: 0 }, ["accountId"])]);
    expect(await capOf()).toBeUndefined();
  });
});

describe("telling the account about its spend", () => {
  const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
  const out: Outbox = {
    keys: masterKeys(env),
    mailer: undefined,
    linkSecret: env.SESSION_SECRET,
    origin: "https://console.test",
  };

  it("warns once past 80% and once more at the limit, in a channel of any setting", async () => {
    const posted: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      posted.push(((await new Request(input, init).json()) as { text: string }).text);
      return new Response("ok");
    });
    const me = await signIn(1, "octo");
    const data = scoped(db, me.account.id);
    const added = await call("/api/notifications/channels", {
      method: "POST",
      auth: me.auth,
      json: { kind: "slack", name: "team", when: "blocking", url: SLACK },
    });
    expect(added.status).toBe(200);

    await spend(data, 7.9, now);
    await tellSpend(data, out, now);
    expect(posted).toHaveLength(0);

    await data.batch((w) => [
      w.upsert("usageCounters", { kind: "spend", day: "2026-03-04", n: 8_500_000 }, [
        "accountId",
        "kind",
        "day",
      ]),
    ]);
    await tellSpend(data, out, now);
    await tellSpend(data, out, now);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("$8.50 today (UTC), of a $10.00 limit");
    expect(posted[0]).toContain("<https://console.test/budget|Open the budget>");

    await data.batch((w) => [
      w.upsert("usageCounters", { kind: "spend", day: "2026-03-04", n: 10_200_000 }, [
        "accountId",
        "kind",
        "day",
      ]),
    ]);
    await tellSpend(data, out, now);
    await tellSpend(data, out, now);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("Hosted reviews wait until the limit resets or is raised.");
  });
});

describe("a pull request's check while its review waits behind a spend limit", () => {
  const report: MergeChecksReportView = {
    head: A,
    conclusion: "pending",
    results: [
      {
        id: "c1",
        kind: "critical_findings",
        mode: "block",
        outcome: "not_evaluated",
        detail: "ocra has not reviewed this head",
      },
    ],
  };

  it("says which limit, and is posted again as a different result", async () => {
    const held = statusOf(report, "https://ocra.example/p", "daily");
    expect(held.title).toBe("Waiting for the review: the daily spend limit is reached");
    expect(held.summary).toContain("starts no review until it resets or is raised");
    expect(statusOf(report, "https://ocra.example/p").title).toBe(
      "Waiting for the review: 1 check not evaluated yet",
    );
    expect(await digestOf(report, "daily")).not.toBe(await digestOf(report));
  });
});
