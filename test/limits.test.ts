import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { call, db, JSON_TYPE, resetDb, signIn, signInCli } from "./helpers.js";
import { rows } from "./table-rows.js";

// The refusals and bounds that had no test (audit K-hyg).

beforeEach(resetDb);
const HASH = "c".repeat(64);

describe("preference versions", () => {
  it("keep the newest 50 when a save adds one", async () => {
    const me = await signIn(1, "octo");
    const d = scoped(db, me.account.id);
    const start = Date.now() - 1_000_000;
    for (let i = 0; i < 55; i++) {
      await d.insert("preferenceVersions", {
        ...rows.preferenceVersions(`v${i}`),
        createdAt: new Date(start + i * 1000),
      });
    }
    const res = await call("/api/preferences", {
      method: "PUT",
      auth: me.auth,
      json: { settings: { concurrency: 4 } },
    });
    expect(res.status).toBe(200);
    const { version } = (await res.json()) as { version: string };

    const kept = (await d.list("preferenceVersions")).map((v) => v.id);
    expect(kept).toHaveLength(50);
    expect(kept).toContain(version);
    // The six oldest went: v0..v5.
    for (let i = 0; i < 6; i++) expect(kept).not.toContain(`v${i}`);
    expect(kept).toContain("v6");
  });

  it("refuse to restore a version that no longer fits today's rules", async () => {
    const me = await signIn(1, "octo");
    const d = scoped(db, me.account.id);
    await d.insert("preferenceVersions", {
      id: "old-rules",
      snapshot: { settings: { concurrency: 999 } },
      changed: ["concurrency"],
    });
    const res = await call("/api/preferences/versions/old-rules/restore", {
      method: "POST",
      auth: me.auth,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "version_no_longer_valid" });
    expect(await d.list("preferences")).toEqual([]);
    expect((await d.list("preferenceVersions")).map((v) => v.id)).toEqual(["old-rules"]);
  });
});

describe("bodies too large", () => {
  const big = (bytes: number) =>
    JSON.stringify({ runId: "r", repoHash: HASH, source: "local", pad: "x".repeat(bytes) });

  it("a review upload over 600 KB is refused, whether or not it declares its length", async () => {
    const { account, auth } = await signInCli(1, "octo");
    const body = big(600_001);
    const lengths: Record<string, string>[] = [{ "content-length": String(body.length) }, {}];
    for (const declared of lengths) {
      const res = await call("/api/reviews", {
        method: "POST",
        auth,
        headers: { ...JSON_TYPE, ...declared },
        body,
      });
      expect(res.status, JSON.stringify(declared)).toBe(413);
      expect(await res.json()).toEqual({ error: "body_too_large" });
    }
    expect(await scoped(db, account.id).list("reviews")).toEqual([]);
    // Just under the bound is read as usual (and refused only for its content).
    const ok = await call("/api/reviews", {
      method: "POST",
      auth,
      headers: JSON_TYPE,
      body: big(1000),
    });
    expect(ok.status).toBe(200);
  });

  it("a gateway call over 8 MB is refused and not recorded, whether or not it declares its length", async () => {
    const me = await signInCli(1, "octo");
    const web = await signIn(1, "octo");
    // A stored key, so the call gets as far as reading the body.
    await call("/api/keys/openrouter", {
      method: "PUT",
      auth: web.auth,
      json: { key: "sk-0123456789" },
    });
    const body = JSON.stringify({ model: "m", pad: "x".repeat(8 * 1024 * 1024) });
    const lengths: Record<string, string>[] = [{ "content-length": String(body.length) }, {}];
    for (const declared of lengths) {
      const res = await call("/api/gateway/openrouter/v1/chat/completions", {
        method: "POST",
        auth: me.auth,
        headers: { ...JSON_TYPE, ...declared },
        body,
      });
      expect(res.status, JSON.stringify(declared)).toBe(413);
      expect(await res.json()).toEqual({ error: "body_too_large" });
    }
    expect(await scoped(db, me.account.id).list("gatewayCalls")).toEqual([]);
  });
});

describe("account memory", () => {
  it("refuses a 501st entry for one repository, and still takes another repository's", async () => {
    const me = await signIn(1, "octo");
    const d = scoped(db, me.account.id);
    for (const [review, repoHash] of [
      ["full-repo", HASH],
      ["other-repo", "d".repeat(64)],
    ] as const) {
      await d.insert("reviews", { ...rows.reviews(review), repoHash });
      await d.insert("findings", {
        ...rows.findings(`f-${review}`),
        reviewId: review,
        fingerprint: `new-${review}`,
      });
    }
    // 500 entries, ten rows a statement (D1 binds at most 100 values).
    const entries = Array.from({ length: 500 }, (_, i) => ({
      ...rows.accountMemory(`m${i}`),
      accountId: me.account.id,
      repoHash: HASH,
    }));
    for (let i = 0; i < entries.length; i += 10) {
      await db.insert(schema.accountMemory).values(entries.slice(i, i + 10));
    }
    const remember = (findingId: string) =>
      call("/api/memory", {
        method: "POST",
        auth: me.auth,
        json: { findingId, reason: "accepted risk" },
      });

    const full = await remember("f-full-repo");
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "memory_full", limit: 500 });
    expect(await d.list("accountMemory")).toHaveLength(500);

    expect((await remember("f-other-repo")).status).toBe(200);
    expect(await d.list("accountMemory")).toHaveLength(501);
  });
});

describe("deleting a review", () => {
  it("deletes its findings and no other review's", async () => {
    const me = await signIn(1, "octo");
    const d = scoped(db, me.account.id);
    for (const review of ["gone", "kept"]) {
      await d.insert("reviews", rows.reviews(review));
      for (const n of [1, 2]) {
        await d.insert("findings", { ...rows.findings(`${review}-${n}`), reviewId: review });
      }
    }
    const res = await call("/api/reviews/gone", { method: "DELETE", auth: me.auth });
    expect(await res.json()).toEqual({ removed: true });
    expect((await d.list("findings")).map((f) => f.id).sort()).toEqual(["kept-1", "kept-2"]);
  });
});
