import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountSalt, setSharing } from "../src/db/accounts.js";
import { enforceRetention } from "../src/db/retention.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { EXPORTED } from "../src/export.js";
import worker from "../src/index.js";
import { DAY, utcDay } from "../src/time.js";
import { call, db, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";
import { rows } from "./table-rows.js";

beforeEach(async () => {
  await resetDb();
  await db.delete(schema.deviceCodes);
  await db.delete(schema.serviceCounters);
});
afterEach(() => vi.restoreAllMocks());

const now = new Date("2026-10-04T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe("retention", () => {
  it("deletes records older than 90 days and sessions whose last token expired", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    for (const [id, days] of [
      ["old", 91],
      ["new", 89],
    ] as const) {
      await d.insert("reviews", {
        id,
        runId: id,
        repoHash: "h",
        source: "local",
        createdAt: ago(days),
      });
      await d.insert("gatewayCalls", {
        id,
        provider: "p",
        path: "/x",
        status: 200,
        createdAt: ago(days),
      });
      await d.insert("auditEvents", { id, kind: "k", createdAt: ago(days) });
      await d.insert("usageCounters", { kind: "findings", day: utcDay(ago(days)), n: 1 });
    }
    // A CLI session whose access token expired but whose refresh token lives.
    await d.insert("sessions", {
      id: "cli-live",
      tokenHash: "t1",
      kind: "cli",
      expiresAt: ago(1),
      refreshHash: "r1",
      refreshExpiresAt: new Date(now.getTime() + DAY),
    });
    await d.insert("sessions", { id: "web-dead", tokenHash: "t2", kind: "web", expiresAt: ago(1) });
    await d.insert("apiTokens", { ...rows.apiTokens("token-dead"), expiresAt: ago(1) });
    await d.insert("apiTokens", rows.apiTokens("token-live"));

    await enforceRetention(db, now);
    for (const t of ["reviews", "gatewayCalls", "auditEvents"] as const) {
      expect((await d.list(t)).map((r) => r.id)).toEqual(["new"]);
    }
    expect((await d.list("usageCounters")).map((c) => c.day)).toEqual([utcDay(ago(89))]);
    const ids = (await d.list("sessions")).map((s) => s.id);
    expect(ids).toContain("cli-live");
    expect(ids).not.toContain("web-dead");
    expect((await d.list("apiTokens")).map((t) => t.id)).toEqual(["token-live"]);
  });

  it("forgets when a pull request was seen after 90 days", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("pullSeen", { ...rows.pullSeen("old"), seenAt: ago(91) });
    await d.insert("pullSeen", { ...rows.pullSeen("new"), seenAt: ago(89) });
    await enforceRetention(db, now);
    expect((await d.list("pullSeen")).map((r) => r.id)).toEqual(["new"]);
  });

  it("forgets a team's members 30 days after they were read", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("reviewTeams", { ...rows.reviewTeams("old"), fetchedAt: ago(31) });
    await d.insert("reviewTeams", { ...rows.reviewTeams("new"), fetchedAt: ago(29) });
    await enforceRetention(db, now);
    expect((await d.list("reviewTeams")).map((r) => r.id)).toEqual(["new"]);
  });

  it("forgets a file ticked as viewed 90 days after the tick", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("pullFileViews", { ...rows.pullFileViews("old"), viewedAt: ago(91) });
    await d.insert("pullFileViews", { ...rows.pullFileViews("new"), viewedAt: ago(89) });
    await enforceRetention(db, now);
    expect((await d.list("pullFileViews")).map((r) => r.id)).toEqual(["new"]);
  });

  it("forgets a pull request event a channel was told of after 30 days", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("notifySends", { ...rows.notifySends("old"), createdAt: ago(31) });
    await d.insert("notifySends", { ...rows.notifySends("new"), createdAt: ago(29) });
    await enforceRetention(db, now);
    expect((await d.list("notifySends")).map((r) => r.id)).toEqual(["new"]);
  });

  it("forgets a notification centre's notice after 30 days", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("notificationFeed", { ...rows.notificationFeed("old"), createdAt: ago(31) });
    await d.insert("notificationFeed", { ...rows.notificationFeed("new"), createdAt: ago(29) });
    await enforceRetention(db, now);
    expect((await d.list("notificationFeed")).map((r) => r.id)).toEqual(["new"]);
  });

  it("drops a notice held in quiet hours after two days", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("notifyHeld", { ...rows.notifyHeld("old"), createdAt: ago(2.1) });
    await d.insert("notifyHeld", { ...rows.notifyHeld("new"), createdAt: ago(1.9) });
    await enforceRetention(db, now);
    expect((await d.list("notifyHeld")).map((r) => r.id)).toEqual(["new"]);
  });

  it("forgets a webhook delivery after 30 days", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("notifyDeliveries", { ...rows.notifyDeliveries("old"), createdAt: ago(31) });
    await d.insert("notifyDeliveries", { ...rows.notifyDeliveries("new"), createdAt: ago(29) });
    await enforceRetention(db, now);
    expect((await d.list("notifyDeliveries")).map((r) => r.id)).toEqual(["new"]);
  });

  it("forgets a platform's delivery to us after 7 days, whatever its state", async () => {
    await db.delete(schema.inboundEvents);
    const row = (id: string, days: number, state: "pending" | "done") => ({
      id,
      platform: "github" as const,
      host: "github.com",
      deliveryId: id,
      event: "pull_request",
      repo: "11",
      state,
      createdAt: ago(days),
    });
    await db
      .insert(schema.inboundEvents)
      .values([row("old", 7.5, "done"), row("stuck", 8, "pending"), row("new", 6.5, "done")]);
    await enforceRetention(db, now);
    const left = await db.select({ id: schema.inboundEvents.id }).from(schema.inboundEvents);
    expect(left.map((r) => r.id)).toEqual(["new"]);
  });

  it("deletes a merge-when-ready intent a month after it ended, an armed one after 90 days", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    const intent = (id: string, state: "armed" | "merged", days: number) =>
      d.insert("mergeIntents", { ...rows.mergeIntents(id), state, updatedAt: ago(days) });
    await intent("ended-old", "merged", 31);
    await intent("ended-new", "merged", 29);
    await intent("armed-month", "armed", 31);
    await intent("armed-old", "armed", 91);
    await enforceRetention(db, now);
    const kept = (await d.list("mergeIntents")).map((r) => r.id).sort();
    expect(kept).toEqual(["armed-month", "ended-new"]);
  });

  it("deletes an auto review's finished jobs 90 days after they ended, never one queued or running", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("reviewRepos", rows.reviewRepos("review-repo-of-a"));
    let made = 0;
    for (const table of [
      "reviewJobs",
      "replyJobs",
      "generateJobs",
      "learnJobs",
      "restackJobs",
    ] as const) {
      const job = (id: string, state: "queued" | "running" | "done" | "failed", days: number) =>
        d.insert(table, {
          ...rows[table](id),
          number: ++made,
          state,
          createdAt: ago(days + 1),
          finishedAt: state === "done" || state === "failed" ? ago(days) : null,
        } as never);
      await job("done-old", "done", 91);
      await job("failed-old", "failed", 91);
      await job("done-new", "done", 89);
      await job("queued-old", "queued", 200);
      await job("running-old", "running", 200);
      await enforceRetention(db, now);
      const kept = (await d.list(table)).map((r) => r.id).sort();
      expect(kept, table).toEqual(["done-new", "queued-old", "running-old"]);
    }
  });

  it("deletes a pre-merge check's result 90 days after it was last posted", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("reviewRepos", rows.reviewRepos("review-repo-of-a"));
    const run = (id: string, made: number, posted: number | null) =>
      d.insert("mergeCheckRuns", {
        ...rows.mergeCheckRuns(id),
        createdAt: ago(made),
        postedAt: posted === null ? null : ago(posted),
      });
    await run("old", 91, 91);
    await run("old-unposted", 91, null);
    await run("old-posted-since", 120, 5);
    await run("new", 89, 89);
    await enforceRetention(db, now);
    const kept = (await d.list("mergeCheckRuns")).map((r) => r.id).sort();
    expect(kept).toEqual(["new", "old-posted-since"]);
  });

  it("deletes a stack merge a month after it was last moved, with the layers it held", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("stackMerges", {
      ...rows.stackMerges("old"),
      state: "merged",
      updatedAt: ago(31),
    });
    await d.insert("stackMerges", {
      ...rows.stackMerges("new"),
      state: "merged",
      updatedAt: ago(29),
    });
    for (const id of ["old", "new"]) {
      await d.insert("stackMergeLayers", {
        ...rows.stackMergeLayers(`layer-${id}`),
        mergeId: id,
        fullName: `octo/${id}`,
      });
    }
    await enforceRetention(db, now);
    expect((await d.list("stackMerges")).map((r) => r.id)).toEqual(["new"]);
    expect((await d.list("stackMergeLayers")).map((r) => r.id)).toEqual(["layer-new"]);
  });

  it("deletes a pull request's flow, directories, review threads and assignments 90 days after their last event, and reviews by when they were submitted", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("reviewRepos", rows.reviewRepos("repo"));
    for (const [id, days] of [
      ["old", 91],
      ["new", 89],
    ] as const) {
      await d.insert("pullFlows", {
        ...rows.pullFlows(id),
        reviewRepoId: "repo",
        number: days,
        seenAt: ago(days),
      });
      await d.insert("pullReviews", {
        ...rows.pullReviews(id),
        reviewRepoId: "repo",
        submittedAt: ago(days),
      });
      await d.insert("pullPaths", {
        ...rows.pullPaths(id),
        reviewRepoId: "repo",
        seenAt: ago(days),
      });
      await d.insert("reviewThreads", {
        ...rows.reviewThreads(id),
        reviewRepoId: "repo",
        seenAt: ago(days),
      });
      await d.insert("findingThreads", {
        ...rows.findingThreads(id),
        reviewRepoId: "repo",
        seenAt: ago(days),
      });
      await d.insert("automationAssignments", {
        ...rows.automationAssignments(id),
        reviewRepoId: "repo",
        createdAt: ago(days),
      });
    }
    await enforceRetention(db, now);
    expect((await d.list("pullFlows")).map((r) => r.id)).toEqual(["new"]);
    expect((await d.list("pullReviews")).map((r) => r.id)).toEqual(["new"]);
    expect((await d.list("pullPaths")).map((r) => r.id)).toEqual(["new"]);
    expect((await d.list("reviewThreads")).map((r) => r.id)).toEqual(["new"]);
    expect((await d.list("findingThreads")).map((r) => r.id)).toEqual(["new"]);
    expect((await d.list("automationAssignments")).map((r) => r.id)).toEqual(["new"]);
  });

  it("keeps only today's service counts, the per-network ones included", async () => {
    await db.insert(schema.serviceCounters).values([
      { name: "device_codes", day: utcDay(ago(1)), n: 5 },
      { name: "device_codes:k1", day: utcDay(ago(1)), n: 2 },
      { name: "device_codes", day: utcDay(now), n: 1 },
      { name: "device_codes:k2", day: utcDay(now), n: 1 },
    ]);
    await enforceRetention(db, now);
    const left = await db.select().from(schema.serviceCounters);
    expect(left.map((r) => r.name).sort()).toEqual(["device_codes", "device_codes:k2"]);
    expect(left.every((r) => r.day === utcDay(now))).toBe(true);
  });

  it("deletes an old review's findings with it", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    for (const [id, days] of [
      ["old", 91],
      ["new", 1],
    ] as const) {
      await d.insert("reviews", { ...rows.reviews(id), createdAt: ago(days) });
      await d.insert("findings", { ...rows.findings(`f-${id}`), reviewId: id });
    }
    await enforceRetention(db, now);
    expect((await d.list("findings")).map((f) => f.id)).toEqual(["f-new"]);
  });

  it("deletes an old review's conversation with it", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    for (const [id, days] of [
      ["old", 91],
      ["new", 1],
    ] as const) {
      await d.insert("reviews", { ...rows.reviews(id), createdAt: ago(days) });
      await d.insert("reviewChatMessages", { ...rows.reviewChatMessages(`m-${id}`), reviewId: id });
    }
    await enforceRetention(db, now);
    expect((await d.list("reviewChatMessages")).map((m) => m.id)).toEqual(["m-new"]);
  });

  it("deletes the record of an issue opened from an old review's finding with it", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    for (const [id, days] of [
      ["old", 91],
      ["new", 1],
    ] as const) {
      await d.insert("reviews", { ...rows.reviews(id), createdAt: ago(days) });
      await d.insert("findings", { ...rows.findings(`f-${id}`), reviewId: id });
      await d.insert("findingIssues", {
        ...rows.findingIssues(`i-${id}`),
        findingId: `f-${id}`,
        reviewId: id,
      });
    }
    await enforceRetention(db, now);
    expect((await d.list("findingIssues")).map((i) => i.id)).toEqual(["i-new"]);
  });

  it("runs every delete when one fails, logs only its own message, then throws", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("reviews", { ...rows.reviews("old"), createdAt: ago(91) });
    await d.insert("gatewayCalls", { ...rows.gatewayCalls("old"), createdAt: ago(91) });
    await d.insert("auditEvents", { ...rows.auditEvents("old"), createdAt: ago(91) });
    await d.insert("sessions", { ...rows.sessions("dead"), expiresAt: ago(1) });
    await db.insert(schema.deviceCodes).values({
      id: "dc",
      deviceCodeHash: "dch",
      userCode: "ABCD-EFGH",
      expiresAt: ago(1),
    });
    // The first delete fails, with an error whose text must not reach the log.
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === "delete") {
          return (table: unknown) => {
            if (table === schema.reviews) throw new Error("D1 said: row sk-secret-123");
            return target.delete(table as typeof schema.reviews);
          };
        }
        return Reflect.get(target, prop);
      },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(enforceRetention(failing, now)).rejects.toThrow("retention failed for: reviews");
    expect(await d.list("reviews")).toHaveLength(1);
    for (const t of ["gatewayCalls", "auditEvents"] as const) {
      expect(await d.list(t), t).toEqual([]);
    }
    // The sign-in's own session is live; the expired one is gone.
    expect((await d.list("sessions")).map((s) => s.id)).not.toContain("dead");
    expect(await d.list("sessions")).toHaveLength(1);
    expect(await db.select().from(schema.deviceCodes)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual([
      { level: "error", event: "retention_failed", table: "reviews", error: "Error" },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk-secret");
  });

  it("runs from the cron trigger", async () => {
    const { account } = await signIn(1, "octo");
    await scoped(db, account.id).insert("reviews", {
      id: "ancient",
      runId: "a",
      repoHash: "h",
      source: "local",
      createdAt: new Date(Date.now() - 200 * DAY),
    });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await scoped(db, account.id).list("reviews")).toEqual([]);
  });

  it("leaves retention to the daily cron, not the hourly one", async () => {
    const { account } = await signIn(1, "octo");
    await scoped(db, account.id).insert("reviews", {
      id: "ancient",
      runId: "a",
      repoHash: "h",
      source: "local",
      createdAt: new Date(Date.now() - 200 * DAY),
    });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "47 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await scoped(db, account.id).count("reviews")).toBe(1);
  });
});

describe("export and deletion", () => {
  it("exports the account's data without key material or other accounts", async () => {
    const me = await signIn(1, "octo");
    const other = await signInCli(2, "other");
    const d = scoped(db, me.account.id);
    await d.insert("providerKeys", {
      id: "k",
      provider: "openai",
      wrappedKey: "WRAPPED",
      ciphertext: "CIPHER",
      last4: "abcd",
    });
    await d.insert("reviews", { id: "r", runId: "r", repoHash: "h", source: "local" });
    await scoped(db, other.account.id).insert("reviews", {
      id: "x",
      runId: "x",
      repoHash: "theirs",
      source: "local",
    });
    const res = await call("/api/export", { auth: me.auth });
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown[]>;
    expect(body.providerKeys).toEqual([
      expect.objectContaining({ provider: "openai", last4: "abcd" }),
    ]);
    expect(body.reviews).toHaveLength(1);
    expect(text).not.toMatch(/WRAPPED|CIPHER|theirs|tokenHash|accountId/);
    expect((await call("/api/export", { auth: other.auth })).status).toBe(403);
  });

  it("holds a row of every account table, the account's switch and its salt", async () => {
    const me = await signIn(1, "octo");
    const d = scoped(db, me.account.id);
    // The findings' review first (the foreign key needs it), then one row per table.
    await d.insert("reviews", rows.reviews("review-of-a"));
    for (const [table, row] of Object.entries(rows)) {
      const later = [
        "reviews",
        "graphBuilds",
        "graphChunks",
        "pullImpacts",
        "reviewJobs",
        "replyJobs",
        "closedPulls",
        "pullFlows",
        "pullIndex",
        "pullReviews",
        "reviewThreads",
        "findingThreads",
        "pullPaths",
        "reviewRequests",
        "automationAssignments",
        "mergeChecks",
        "mergeCheckRuns",
        "generateJobs",
        "restackJobs",
        "learnJobs",
        "pullCommands",
        "pausedPulls",
        "liveEvents",
        "liveGrants",
        "liveComments",
        "findingIssues",
        "stackMergeLayers",
      ];
      if (later.includes(table)) continue;
      await d.insert(table as keyof typeof rows, row(`x-${table}`) as never);
    }
    await d.insert("findingIssues", {
      ...rows.findingIssues("x-findingIssues"),
      findingId: "x-findings",
    });
    await d.insert("stackMergeLayers", {
      ...rows.stackMergeLayers("x-stackMergeLayers"),
      mergeId: "x-stackMerges",
    });
    await d.insert("graphBuilds", {
      ...rows.graphBuilds("x-graphBuilds"),
      graphRepoId: "x-graphRepos",
    });
    await d.insert("graphChunks", {
      ...rows.graphChunks("x-graphChunks"),
      buildId: "x-graphBuilds",
    });
    await d.insert("pullImpacts", {
      ...rows.pullImpacts("x-pullImpacts"),
      graphRepoId: "x-graphRepos",
    });
    await d.insert("reviewJobs", {
      ...rows.reviewJobs("x-reviewJobs"),
      reviewRepoId: "x-reviewRepos",
    });
    await d.insert("replyJobs", {
      ...rows.replyJobs("x-replyJobs"),
      reviewRepoId: "x-reviewRepos",
    });
    for (const table of [
      "closedPulls",
      "pullFlows",
      "pullIndex",
      "pullReviews",
      "reviewThreads",
      "findingThreads",
      "pullPaths",
      "reviewRequests",
      "automationAssignments",
      "mergeChecks",
      "mergeCheckRuns",
      "generateJobs",
      "restackJobs",
      "learnJobs",
      "pullCommands",
      "pausedPulls",
    ] as const) {
      await d.insert(table, {
        ...rows[table](`x-${table}`),
        reviewRepoId: "x-reviewRepos",
      } as never);
    }
    const live = { liveRunId: "x-liveRuns" };
    await d.insert("liveEvents", { ...rows.liveEvents("x-liveEvents"), ...live });
    await d.insert("liveGrants", {
      ...rows.liveGrants("x-liveGrants"),
      ...live,
      granteeId: me.account.id,
    });
    await d.insert("liveComments", { ...rows.liveComments("x-liveComments"), ...live });
    await setSharing(db, me.account.id, true);
    const salt = await accountSalt(db, me.account.id);
    const zone = await call("/api/notifications/time-zone", {
      method: "PUT",
      auth: me.auth,
      headers: { origin: ORIGIN },
      json: { timeZone: "Europe/Berlin" },
    });
    expect(zone.status).toBe(200);

    const body = (await (await call("/api/export", { auth: me.auth })).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(EXPORTED).sort()).toEqual(Object.keys(rows).sort());
    for (const [table, key] of Object.entries(EXPORTED)) {
      expect((body[key] as unknown[] | undefined)?.length, table).toBeGreaterThan(0);
    }
    expect(body.account).toEqual(
      expect.objectContaining({
        login: "octo",
        shareFindings: true,
        salt,
        timeZone: "Europe/Berlin",
      }),
    );
  });

  it("carries the account's digest and report schedule and each channel's settings", async () => {
    const me = await signIn(1, "octo");
    const sentFor = new Date(Date.UTC(2026, 10, 16, 9));
    await db
      .update(schema.accounts)
      .set({ digestDay: "2026-11-21", reportWeekday: 3, reportHour: 17, reportSentFor: sentFor })
      .where(eq(schema.accounts.id, me.account.id));
    await scoped(db, me.account.id).insert("notifyChannels", {
      ...rows.notifyChannels("x-channel"),
      digest: true,
      weekly: true,
      events: ["review_requested", "checks_failed"],
      reminderHours: 4,
      quietStart: 22,
      quietEnd: 7,
    });

    const body = (await (await call("/api/export", { auth: me.auth })).json()) as {
      account: Record<string, unknown>;
      notifyChannels: Record<string, unknown>[];
    };
    expect(body.account).toEqual(
      expect.objectContaining({
        digestDay: "2026-11-21",
        reportWeekday: 3,
        reportHour: 17,
        reportSentFor: sentFor.toISOString(),
      }),
    );
    expect(body.notifyChannels).toEqual([
      expect.objectContaining({
        digest: true,
        weekly: true,
        events: ["review_requested", "checks_failed"],
        reminderHours: 4,
        quietStart: 22,
        quietEnd: 7,
      }),
    ]);
  });

  it("deletes one review of the caller's own", async () => {
    const me = await signIn(1, "octo");
    const other = await signIn(2, "other");
    await scoped(db, me.account.id).insert("reviews", {
      id: "r",
      runId: "r",
      repoHash: "h",
      source: "local",
    });
    const theirs = await call("/api/reviews/r", { method: "DELETE", auth: other.auth });
    expect(await theirs.json()).toEqual({ removed: false });
    const mine = await call("/api/reviews/r", { method: "DELETE", auth: me.auth });
    expect(await mine.json()).toEqual({ removed: true });
  });
});
