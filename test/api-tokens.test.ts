import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto.js";
import { enforceRetention } from "../src/db/retention.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import app from "../src/index.js";
import { DAY, HOUR } from "../src/time.js";
import { call, db, ORIGIN, request, resetDb, signIn, signInCli } from "./helpers.js";
import { rows } from "./table-rows.js";

// Personal API tokens: made, listed and revoked from a browser session only;
// stored as a hash; reaching only the read routes their scopes list.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

type Made = { token: { id: string; prefix: string; lastUsedAt: string | null }; secret: string };

async function make(auth: Record<string, string>, body: unknown = {}) {
  return call("/api/tokens", {
    method: "POST",
    auth,
    json: { name: "ci", scopes: ["reviews:read"], expiresInDays: 30, ...(body as object) },
  });
}

async function made(auth: Record<string, string>, body: unknown = {}): Promise<Made> {
  const res = await make(auth, body);
  expect(res.status).toBe(201);
  return (await res.json()) as Made;
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

describe("making a token", () => {
  it("answers the secret once, and stores only its hash", async () => {
    const me = await signIn(1, "octo");
    const log = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn"),
    ];
    const { token, secret } = await made(me.auth, { name: "nightly" });
    expect(secret).toMatch(/^ocra_pat_[A-Za-z0-9_-]{43}$/);
    expect(token.prefix).toBe(secret.slice(0, 15));
    expect((await call("/api/reviews", { auth: bearer(secret) })).status).toBe(200);

    const listed = await (await call("/api/tokens", { auth: me.auth })).text();
    expect(listed).toContain("nightly");
    expect(listed).not.toContain(secret);
    const hash = await sha256Hex(secret);
    expect(listed).not.toContain(hash);

    const stored = await db.select().from(schema.apiTokens);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(hash);
    const audited = await db.select().from(schema.auditEvents);
    const everything = JSON.stringify([stored, audited]);
    expect(everything).not.toContain(secret);
    expect(JSON.stringify(audited)).not.toContain(hash);
    expect(audited.map((e) => e.kind).sort()).toEqual(["token.created", "token.first_used"]);

    const exported = await (await call("/api/export", { auth: me.auth })).text();
    expect(exported).toContain("nightly");
    expect(exported).not.toContain(secret);
    expect(exported).not.toContain(hash);

    expect(JSON.stringify(log.map((l) => l.mock.calls))).not.toContain(secret.slice(9));
  });

  it("needs a name, one known scope or more, and an expiry within a year", async () => {
    const me = await signIn(1, "octo");
    expect((await make(me.auth, { expiresInDays: 366 })).status).toBe(400);
    expect((await make(me.auth, { expiresInDays: 0 })).status).toBe(400);
    expect((await make(me.auth, { expiresInDays: undefined })).status).toBe(400);
    expect((await make(me.auth, { scopes: [] })).status).toBe(400);
    expect((await make(me.auth, { scopes: ["keys:write"] })).status).toBe(400);
    expect((await make(me.auth, { name: " " })).status).toBe(400);
    expect((await make(me.auth, { admin: true })).status).toBe(400);
    expect((await make(me.auth, { expiresInDays: 365 })).status).toBe(201);
  });

  it("holds at most 20 tokens an account", async () => {
    const me = await signIn(1, "octo");
    for (let i = 0; i < 20; i++) await made(me.auth);
    expect((await make(me.auth)).status).toBe(400);
  });

  it("needs a recent sign-in", async () => {
    const me = await signIn(1, "octo");
    const d = scoped(db, me.account.id);
    const [session] = await d.list("sessions");
    await d.update("sessions", session?.id ?? "", { createdAt: new Date(Date.now() - HOUR) });
    const res = await make(me.auth);
    expect(res.status).toBe(403);
    expect(await db.select().from(schema.apiTokens)).toHaveLength(0);
  });

  it("refuses a browser request from another origin (CSRF), and takes one from this one", async () => {
    const me = await signIn(1, "octo");
    const cookie = { cookie: `__Host-ocra_session=${me.token}` };
    const body = { name: "ci", scopes: ["reviews:read"], expiresInDays: 30 };
    const foreign = await call("/api/tokens", {
      method: "POST",
      json: body,
      headers: { ...cookie, origin: "https://evil.test" },
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "bad_origin" });
    const own = await call("/api/tokens", {
      method: "POST",
      json: body,
      headers: { ...cookie, origin: ORIGIN },
    });
    expect(own.status).toBe(201);
  });
});

describe("managing tokens", () => {
  it("is refused to a token, whatever its scopes, and to the CLI", async () => {
    const me = await signIn(1, "octo");
    const { token, secret } = await made(me.auth, {
      scopes: ["reviews:read", "insights:read", "pulls:read"],
    });
    const cli = await signInCli(2, "terminal");
    for (const auth of [bearer(secret), cli.auth]) {
      expect((await call("/api/tokens", { auth })).status).toBe(403);
      expect((await make(auth)).status).toBe(403);
      const del = await call(`/api/tokens/${token.id}`, { method: "DELETE", auth });
      expect(del.status).toBe(403);
    }
    for (const path of ["/api/keys", "/api/sessions", "/api/notifications/channels", "/api/me"]) {
      expect((await call(path, { auth: bearer(secret) })).status, path).toBe(403);
    }
    expect((await call("/api/tokens", { auth: me.auth })).status).toBe(200);
  });

  it("revokes a token at once, and only the account's own", async () => {
    const me = await signIn(1, "octo");
    const other = await signIn(2, "other");
    const { token, secret } = await made(me.auth);
    const theirs = await call(`/api/tokens/${token.id}`, { method: "DELETE", auth: other.auth });
    expect(await theirs.json()).toEqual({ removed: false });
    expect((await call("/api/reviews", { auth: bearer(secret) })).status).toBe(200);

    const del = await call(`/api/tokens/${token.id}`, { method: "DELETE", auth: me.auth });
    expect(await del.json()).toEqual({ removed: true });
    const res = await call("/api/reviews", { auth: bearer(secret) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    const kinds = (await scoped(db, me.account.id).list("auditEvents")).map((e) => e.kind);
    expect(kinds).toContain("token.revoked");
  });
});

describe("calling with a token", () => {
  it("refuses an expired token", async () => {
    const me = await signIn(1, "octo");
    const { token, secret } = await made(me.auth);
    await scoped(db, me.account.id).update("apiTokens", token.id, {
      expiresAt: new Date(Date.now() - 1000),
    });
    expect((await call("/api/reviews", { auth: bearer(secret) })).status).toBe(401);
    const listed = (await (await call("/api/tokens", { auth: me.auth })).json()) as {
      tokens: unknown[];
    };
    expect(listed.tokens).toEqual([]);
  });

  it("refuses a secret one character off, and one never made", async () => {
    const me = await signIn(1, "octo");
    const { secret } = await made(me.auth);
    const last = secret.at(-1) === "A" ? "B" : "A";
    for (const wrong of [secret.slice(0, -1) + last, `ocra_pat_${"x".repeat(43)}`, "ocra_pat_"]) {
      const res = await call("/api/reviews", { auth: bearer(wrong) });
      expect(res.status).toBe(401);
    }
  });

  it("refuses a route its scopes do not list, naming the scope", async () => {
    const me = await signIn(1, "octo");
    const { secret } = await made(me.auth, { scopes: ["insights:read"] });
    const res = await call("/api/reviews", { auth: bearer(secret) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_for_session", scope: "reviews:read" });
    expect((await call("/api/insights/flow", { auth: bearer(secret) })).status).toBe(200);
  });

  it("refuses every write, even on a route it may read", async () => {
    const me = await signIn(1, "octo");
    const { secret } = await made(me.auth, {
      scopes: ["reviews:read", "insights:read", "pulls:read"],
    });
    await scoped(db, me.account.id).insert("reviews", rows.reviews("mine"));
    const res = await call("/api/reviews/mine", { method: "DELETE", auth: bearer(secret) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_for_session" });
    expect(await scoped(db, me.account.id).get("reviews", "mine")).toBeDefined();
  });

  it("reads only its own account's data", async () => {
    const me = await signIn(1, "octo");
    const other = await signIn(2, "other");
    await scoped(db, me.account.id).insert("reviews", rows.reviews("mine"));
    await scoped(db, other.account.id).insert("reviews", rows.reviews("theirs"));
    const { secret } = await made(me.auth);
    const list = (await (await call("/api/reviews", { auth: bearer(secret) })).json()) as {
      reviews: { id: string }[];
    };
    expect(list.reviews.map((r) => r.id)).toEqual(["mine"]);
    expect((await call("/api/reviews/mine", { auth: bearer(secret) })).status).toBe(200);
    expect((await call("/api/reviews/theirs", { auth: bearer(secret) })).status).toBe(404);
  });

  it("writes its last use at most once a minute, and audits its first use once", async () => {
    const me = await signIn(1, "octo");
    const { token, secret } = await made(me.auth);
    const d = scoped(db, me.account.id);
    await Promise.all([1, 2, 3].map(() => call("/api/reviews", { auth: bearer(secret) })));
    const used = (await d.get("apiTokens", token.id))?.lastUsedAt;
    expect(used).toBeInstanceOf(Date);
    await call("/api/reviews", { auth: bearer(secret) });
    expect((await d.get("apiTokens", token.id))?.lastUsedAt).toEqual(used);
    const firsts = (await d.list("auditEvents")).filter((e) => e.kind === "token.first_used");
    expect(firsts).toHaveLength(1);
    expect(firsts[0]?.detail).toEqual({ prefix: token.prefix });

    const old = new Date(Date.now() - 2 * 60_000);
    await d.update("apiTokens", token.id, { lastUsedAt: old });
    await call("/api/reviews", { auth: bearer(secret) });
    expect((await d.get("apiTokens", token.id))?.lastUsedAt?.getTime()).toBeGreaterThan(
      old.getTime(),
    );
  });

  it("is limited per token, apart from the account's other calls", async () => {
    const me = await signIn(1, "octo");
    const { token, secret } = await made(me.auth);
    const keys: string[] = [];
    const ACCOUNT_CALLS = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: !key.startsWith("token:") };
      },
    };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      request("/api/reviews", { auth: bearer(secret) }),
      { ...env, ACCOUNT_CALLS },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(keys).toEqual([`token:${token.id}`]);
  });

  it("is deleted by retention once expired", async () => {
    const me = await signIn(1, "octo");
    await made(me.auth, { expiresInDays: 1 });
    await enforceRetention(db, new Date(Date.now() + 2 * DAY));
    expect(await db.select().from(schema.apiTokens)).toHaveLength(0);
  });
});
