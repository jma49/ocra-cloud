import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import app from "../src/index.js";
import { type CallInit, call, db, request, resetDb, signIn } from "./helpers.js";

// Audit C5: an outbound call that never answers must not hold the request
// open, nor leave a gateway call pending, for as long as the client waits.

beforeEach(resetDb);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A fetch that answers `answer` for the URLs it is given, and for any other only fails once its signal aborts. */
function stalling(answer: Record<string, () => Response> = {}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockClear()
    .mockImplementation((input, init) => {
      const url = new Request(input).url;
      const make = answer[url];
      if (make) return Promise.resolve(make());
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    });
}

/** Starts the request, lets it reach its outbound fetch, then moves the clock on by `ms`. */
async function stalled(
  path: string,
  init: CallInit,
  fetches: { mock: { calls: unknown[] } },
  ms: number,
  calls = 1,
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const ctx = createExecutionContext();
  const pending = app.fetch(request(path, init), env, ctx);
  for (let i = 0; i < 200 && fetches.mock.calls.length < calls; i++) await scheduler.wait(5);
  expect(fetches.mock.calls).toHaveLength(calls);
  await vi.advanceTimersByTimeAsync(ms);
  // A request still waiting a real second later never gave up.
  const res = await Promise.race([pending, scheduler.wait(1000).then(() => null)]);
  if (res) await waitOnExecutionContext(ctx);
  return res;
}

const MINUTE = 60_000;
const GATEWAY = "/api/gateway/openrouter/v1/chat/completions";
const chat = { model: "vendor/model-a", messages: [{ role: "user", content: "hi" }] };

describe("the gateway", () => {
  async function withKey() {
    const user = await signIn(1, "octo");
    const res = await call("/api/keys/openrouter", {
      method: "PUT",
      auth: user.auth,
      json: { key: "sk-or-0123456789" },
    });
    expect(res.status).toBe(200);
    return user;
  }

  it("gives up on a provider that does not start answering in 5 minutes, and records it", async () => {
    const { auth, account } = await withKey();
    const fetches = stalling();
    const res = await stalled(GATEWAY, { method: "POST", auth, json: chat }, fetches, 5 * MINUTE);
    expect(res?.status).toBe(502);
    expect(await res?.json()).toEqual({ error: "upstream_unreachable" });
    expect(await scoped(db, account.id).list("gatewayCalls")).toMatchObject([{ status: 504 }]);
  });

  it("waits for an answer that starts in time", async () => {
    const { auth, account } = await withKey();
    const fetches = stalling();
    const res = await stalled(GATEWAY, { method: "POST", auth, json: chat }, fetches, 4 * MINUTE);
    expect(res).toBeNull();
    expect(await scoped(db, account.id).list("gatewayCalls")).toMatchObject([{ status: 0 }]);
  });

  it("stops waiting when the client goes away first, and records it", async () => {
    const { auth, account } = await withKey();
    const fetches = stalling();
    const client = new AbortController();
    const ctx = createExecutionContext();
    const pending = app.fetch(
      request(GATEWAY, { method: "POST", auth, json: chat, signal: client.signal }),
      env,
      ctx,
    );
    for (let i = 0; i < 200 && fetches.mock.calls.length < 1; i++) await scheduler.wait(5);
    client.abort();
    const res = await Promise.race([pending, scheduler.wait(1000).then(() => null)]);
    expect(res).not.toBeNull();
    await waitOnExecutionContext(ctx);
    expect(await scoped(db, account.id).list("gatewayCalls")).toMatchObject([{ status: 499 }]);
  });
});

describe("GitHub sign-in", () => {
  const STATE = "__Host-ocra_oauth_state";

  /** The callback request, with the state the login step signed. */
  async function callback(): Promise<[string, CallInit]> {
    const start = await call("/api/auth/github/login");
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const cookie = start.headers
      .getSetCookie()
      .map((l) => l.split(";")[0] ?? "")
      .find((p) => p.startsWith(`${STATE}=`));
    return [
      `/api/auth/github/callback?code=c&state=${state}`,
      { headers: { cookie: cookie ?? "" } },
    ];
  }

  it("gives up on a token exchange that takes over 10 seconds", async () => {
    const [path, init] = await callback();
    const fetches = stalling();
    const res = await stalled(path, init, fetches, 10_000);
    expect(res?.status).toBe(502);
    expect(await res?.json()).toEqual({ error: "github_exchange" });
  });

  it("gives up on a user lookup that takes over 10 seconds", async () => {
    const [path, init] = await callback();
    const fetches = stalling({
      "https://github.com/login/oauth/access_token": () => Response.json({ access_token: "gho_t" }),
    });
    const res = await stalled(path, init, fetches, 10_000, 2);
    expect(res?.status).toBe(502);
    expect(await res?.json()).toEqual({ error: "github_user" });
  });
});
