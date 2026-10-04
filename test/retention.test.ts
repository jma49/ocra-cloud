import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { accountSalt, setSharing } from "../src/db/accounts.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { EXPORTED } from "../src/export.js";
import worker from "../src/index.js";
import { enforceRetention } from "../src/retention.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";
import { rows } from "./table-rows.js";

beforeEach(async () => {
  await resetDb();
  await db.delete(schema.deviceCodes);
});

const DAY = 86_400_000;
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
    const ids = (await d.list("sessions")).map((s) => s.id);
    expect(ids).toContain("cli-live");
    expect(ids).not.toContain("web-dead");
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
    const res = await call("/api/export", { headers: me.auth });
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown[]>;
    expect(body.providerKeys).toEqual([
      expect.objectContaining({ provider: "openai", last4: "abcd" }),
    ]);
    expect(body.reviews).toHaveLength(1);
    expect(text).not.toMatch(/WRAPPED|CIPHER|theirs|tokenHash|accountId/);
    expect((await call("/api/export", { headers: other.auth })).status).toBe(403);
  });

  it("holds a row of every account table, the account's switch and its salt", async () => {
    const me = await signIn(1, "octo");
    const d = scoped(db, me.account.id);
    // The findings' review first (the foreign key needs it), then one row per table.
    await d.insert("reviews", rows.reviews("review-of-a"));
    for (const [table, row] of Object.entries(rows)) {
      if (table === "reviews") continue;
      await d.insert(table as keyof typeof rows, row(`x-${table}`) as never);
    }
    await setSharing(db, me.account.id, true);
    const salt = await accountSalt(db, me.account.id);

    const body = (await (await call("/api/export", { headers: me.auth })).json()) as Record<
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
    const theirs = await call("/api/reviews/r", { method: "DELETE", headers: other.auth });
    expect(await theirs.json()).toEqual({ removed: false });
    const mine = await call("/api/reviews/r", { method: "DELETE", headers: me.auth });
    expect(await mine.json()).toEqual({ removed: true });
  });
});
