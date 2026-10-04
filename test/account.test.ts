import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { call, db, ORIGIN, resetDb, signIn } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const json = { "content-type": "application/json" };

describe("usage", () => {
  it("sums calls by day and by model for the caller only", async () => {
    const me = await signIn(1, "me");
    const other = await signIn(2, "other");
    const mine = scoped(db, me.account.id);
    const now = Date.now();
    const row = (id: string, model: string, status: number, ago: number, tin = 10, tout = 5) => ({
      id,
      provider: "openrouter",
      path: "/v1/chat/completions",
      model,
      status,
      tokensIn: tin,
      tokensOut: tout,
      createdAt: new Date(now - ago),
    });
    await mine.insert("gatewayCalls", row("a", "m1", 200, 0));
    await mine.insert("gatewayCalls", row("b", "m1", 429, 0));
    await mine.insert("gatewayCalls", row("c", "m2", 200, 3 * 86_400_000));
    await mine.insert("gatewayCalls", row("old", "m2", 200, 40 * 86_400_000));
    await scoped(db, other.account.id).insert("gatewayCalls", row("x", "theirs", 200, 0));

    const body = (await (await call("/api/usage?days=14", { headers: me.auth })).json()) as {
      today: number;
      series: { day: string; calls: number; errors: number; tokensIn: number }[];
      models: { model: string; calls: number }[];
      calls: { id: string }[];
    };
    expect(body.today).toBe(2);
    expect(body.series).toHaveLength(14);
    expect(body.series.at(-1)).toMatchObject({ calls: 2, errors: 1, tokensIn: 20 });
    expect(body.series.reduce((n, d) => n + d.calls, 0)).toBe(3);
    expect(body.models).toEqual([
      expect.objectContaining({ model: "m1", calls: 2 }),
      expect.objectContaining({ model: "m2", calls: 1 }),
    ]);
    expect(body.calls.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    expect(JSON.stringify(body)).not.toContain("theirs");
  });
});

describe("sessions", () => {
  it("lists the caller's sessions, marks the current one, and records use", async () => {
    const me = await signIn(1, "me");
    await signIn(2, "other");
    const list = (await (await call("/api/sessions", { headers: me.auth })).json()) as {
      sessions: { id: string; current: boolean; kind: string; lastUsedAt: string | null }[];
    };
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]).toMatchObject({ current: true, kind: "web" });
    const [row] = await scoped(db, me.account.id).list("sessions");
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("revokes the caller's own sessions only", async () => {
    const me = await signIn(1, "me");
    const other = await signIn(2, "other");
    const [theirs] = await scoped(db, other.account.id).list("sessions");
    const del = await call(`/api/sessions/${theirs?.id}`, { method: "DELETE", headers: me.auth });
    expect(await del.json()).toEqual({ removed: false });
    expect((await call("/api/me", { headers: other.auth })).status).toBe(200);

    const [mine] = await scoped(db, me.account.id).list("sessions");
    await call(`/api/sessions/${mine?.id}`, { method: "DELETE", headers: me.auth });
    expect((await call("/api/me", { headers: me.auth })).status).toBe(401);
  });
});

describe("deleting an account", () => {
  it("needs the login typed back, then removes the account and everything it owns", async () => {
    const me = await signIn(1, "me");
    const other = await signIn(2, "other");
    await call("/api/keys/openrouter", {
      method: "PUT",
      headers: { ...me.auth, ...json },
      body: JSON.stringify({ key: "sk-0123456789" }),
    });
    const wrong = await call("/api/account", {
      method: "DELETE",
      headers: { ...me.auth, ...json },
      body: JSON.stringify({ confirm: "other" }),
    });
    expect(wrong.status).toBe(400);

    const ok = await call("/api/account", {
      method: "DELETE",
      headers: { ...me.auth, ...json, origin: ORIGIN },
      body: JSON.stringify({ confirm: "me" }),
    });
    expect(await ok.json()).toEqual({ deleted: true });
    expect((await call("/api/me", { headers: me.auth })).status).toBe(401);
    for (const t of Object.values(schema.accountTables)) {
      const rows = await db.select().from(t).all();
      expect(rows.filter((r) => r.accountId === me.account.id)).toEqual([]);
    }
    expect((await call("/api/me", { headers: other.auth })).status).toBe(200);
  });
});
