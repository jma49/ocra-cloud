import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import app from "../src/index.js";
import { type CallInit, call, db, request, resetDb, signIn, signInCli } from "./helpers.js";
import { metered } from "./metered.js";

// Audit C1: an account's uploads and gateway calls are limited per minute
// (ACCOUNT_CALLS), each route on its own, before the route's queries.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** A limiter that lets `allowed` calls through, then refuses, and the keys it was asked for. */
function limiter(allowed: number) {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: keys.length <= allowed };
      },
    },
  };
}

async function send(path: string, init: CallInit, ACCOUNT_CALLS: unknown) {
  const { DB, meter } = metered();
  const ctx = createExecutionContext();
  const res = await app.fetch(request(path, init), { ...env, DB, ACCOUNT_CALLS }, ctx);
  const body = await res.json();
  await waitOnExecutionContext(ctx);
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body, ...meter };
}

const upload = (runId: string) => ({
  method: "POST",
  json: {
    runId,
    repoHash: "f".repeat(64),
    source: "local",
    findings: { critical: 0, warning: 0, suggestion: 0 },
  },
});

describe("the per-minute limit", () => {
  it("refuses an account's upload past it, writing nothing", async () => {
    const { auth, account } = await signInCli(1, "octo");
    const rate = limiter(1);
    expect((await send("/api/reviews", { ...upload("a"), auth }, rate.binding)).status).toBe(200);
    const refused = await send("/api/reviews", { ...upload("b"), auth }, rate.binding);
    expect(refused).toMatchObject({
      status: 429,
      retryAfter: "60",
      body: { error: "slow_down" },
      written: 0,
    });
    expect(rate.keys).toEqual([`upload:${account.id}`, `upload:${account.id}`]);
    expect((await scoped(db, account.id).list("reviews")).map((r) => r.runId)).toEqual(["a"]);
  });

  it("refuses an account's gateway call past it, without calling the provider", async () => {
    const { auth, account } = await signIn(1, "octo");
    await call("/api/keys/openrouter", { method: "PUT", auth, json: { key: "sk-or-0123456789" } });
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockClear()
      .mockImplementation(async () => Response.json({ usage: {} }));
    const rate = limiter(0);
    const refused = await send(
      "/api/gateway/openrouter/v1/chat/completions",
      { method: "POST", auth, json: { model: "m", messages: [] } },
      rate.binding,
    );
    expect(refused).toMatchObject({ status: 429, body: { error: "slow_down" }, written: 0 });
    expect(rate.keys).toEqual([`gateway:${account.id}`]);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("is a binding of the deployed Worker", () => {
    expect(env.ACCOUNT_CALLS).toBeDefined();
  });
});
