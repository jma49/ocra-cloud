import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountSalt, setSharing } from "../src/db/accounts.js";
import { enforceRetention } from "../src/db/retention.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { EXPORTED } from "../src/export.js";
import worker from "../src/index.js";
import { DAY, utcDay } from "../src/time.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";
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

    await enforceRetention(db, now);
    for (const t of ["reviews", "gatewayCalls", "auditEvents"] as const) {
      expect((await d.list(t)).map((r) => r.id)).toEqual(["new"]);
    }
    expect((await d.list("usageCounters")).map((c) => c.day)).toEqual([utcDay(ago(89))]);
    const ids = (await d.list("sessions")).map((s) => s.id);
    expect(ids).toContain("cli-live");
    expect(ids).not.toContain("web-dead");
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
        "reviewJobs",
        "replyJobs",
        "closedPulls",
        "mergeChecks",
        "mergeCheckRuns",
        "generateJobs",
      ];
      if (later.includes(table)) continue;
      await d.insert(table as keyof typeof rows, row(`x-${table}`) as never);
    }
    await d.insert("graphBuilds", {
      ...rows.graphBuilds("x-graphBuilds"),
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
    for (const table of ["closedPulls", "mergeChecks", "mergeCheckRuns", "generateJobs"] as const) {
      await d.insert(table, {
        ...rows[table](`x-${table}`),
        reviewRepoId: "x-reviewRepos",
      } as never);
    }
    await setSharing(db, me.account.id, true);
    const salt = await accountSalt(db, me.account.id);

    const body = (await (await call("/api/export", { auth: me.auth })).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(EXPORTED).sort()).toEqual(Object.keys(rows).sort());
    for (const [table, key] of Object.entries(EXPORTED)) {
      expect((body[key] as unknown[] | undefined)?.length, table).toBeGreaterThan(0);
    }
    expect(body.account).toEqual(
      expect.objectContaining({ login: "octo", shareFindings: true, salt }),
    );
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
