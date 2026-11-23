import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { parseUsage, topLevelModel } from "../src/gateway.js";
import app from "../src/index.js";
import { call, db, ORIGIN, request, resetDb, signIn } from "./helpers.js";

const KEY = "sk-or-v1-0123456789abcdef";
const PROMPT = "PROMPT-BODY-should-never-be-logged";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

async function withKey(githubId = 1) {
  const user = await signIn(githubId, `u${githubId}`);
  const res = await call("/api/keys/openrouter", {
    method: "PUT",
    auth: user.auth,
    json: { key: KEY },
  });
  expect(res.status).toBe(200);
  return user;
}

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const parts = [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), "data: [DONE]\n\n"];
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

function upstreamFake(make: () => Response) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockClear()
    .mockImplementation(async () => make());
}

const chatRequest = (stream = true) => ({
  model: "vendor/model-a",
  stream,
  messages: [{ role: "user", content: PROMPT }],
});
/** The request's exact bytes, as the gateway forwards them. */
const chat = (stream = true) => JSON.stringify(chatRequest(stream));

describe("keys", () => {
  it("stores a key encrypted, lists only its last four, and never returns it", async () => {
    const { auth, account } = await withKey();
    const list = await call("/api/keys", { auth: auth });
    const text = await list.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).keys).toMatchObject([{ provider: "openrouter", last4: "cdef" }]);
    const [row] = await scoped(db, account.id).list("providerKeys");
    expect(JSON.stringify(row)).not.toContain(KEY);
  });

  it("refuses unknown providers and malformed keys", async () => {
    const { auth } = await signIn(2, "w");
    const put = (provider: string, key: unknown) =>
      call(`/api/keys/${provider}`, {
        method: "PUT",
        auth: auth,
        json: { key },
      });
    const unknown = await put("evil", KEY);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown_provider" });
    const short = await put("openrouter", "short");
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({
      error: "invalid_body",
      issues: [{ path: ["key"] }],
    });
    expect((await put("openrouter", "has space inside")).status).toBe(400);
    expect((await put("openrouter", 12345678)).status).toBe(400);
  });
});

describe("gateway", () => {
  it("forwards to the provider with the stored key and streams the answer back unchanged", async () => {
    const { auth } = await withKey();
    const events = [
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
    ];
    const fake = upstreamFake(
      () =>
        new Response(sse(events), {
          headers: { "content-type": "text/event-stream", "set-cookie": "x=1" },
        }),
    );
    const res = await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth: auth,
      headers: { cookie: "__Host-ocra_session=leak" },
      json: chatRequest(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const text = await res.text();
    expect(text).toContain('"content":"hi"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);

    const [input, init] = fake.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
    const sent = new Headers(init?.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${KEY}`);
    // The caller's own token and cookies never go upstream.
    expect(sent.get("cookie")).toBeNull();
    expect([...sent.values()].join(" ")).not.toContain("ocra_cli_");
    expect(init?.body).toBe(chat());
  });

  it("records each call with model and token counts, without bodies", async () => {
    const { auth, account } = await withKey();
    upstreamFake(
      () =>
        new Response(sse([{ usage: { prompt_tokens: 120, completion_tokens: 30 } }]), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth: auth,
      json: chatRequest(),
    });
    const calls = await scoped(db, account.id).list("gatewayCalls");
    expect(calls).toMatchObject([
      {
        provider: "openrouter",
        model: "vendor/model-a",
        status: 200,
        tokensIn: 120,
        tokensOut: 30,
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(PROMPT);
  });

  it("records the request's own model and Anthropic's cached input", async () => {
    const { auth, account } = await withKey();
    upstreamFake(
      () =>
        new Response(
          sse([
            { usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 1 } },
            { usage: { output_tokens: 20 } },
          ]),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth: auth,
      json: {
        messages: [{ role: "user", content: [{ type: "x", model: "nested/decoy" }] }],
        model: "vendor/model-b",
      },
    });
    expect(await scoped(db, account.id).list("gatewayCalls")).toMatchObject([
      { model: "vendor/model-b", tokensIn: 910, tokensOut: 20 },
    ]);
  });

  it("logs nothing of the request or the answer", async () => {
    const { auth } = await withKey();
    const logged: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    upstreamFake(() => new Response(sse([{ choices: [{ delta: { content: "ANSWER-TEXT" } }] }])));
    await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth: auth,
      json: chatRequest(),
    });
    // And an upstream that throws, which goes through the error path.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(PROMPT));
    await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth: auth,
      json: chatRequest(),
    });
    const all = logged.join("\n");
    for (const secret of [PROMPT, "ANSWER-TEXT", KEY]) expect(all).not.toContain(secret);
  });

  it("refuses unknown providers, other paths, other methods and missing keys", async () => {
    const { auth } = await withKey();
    const fake = upstreamFake(() => new Response("{}"));
    const post = (path: string) =>
      call(path, {
        method: "POST",
        auth: auth,
        json: chatRequest(),
      });
    expect((await post("/api/gateway/evil/v1/chat/completions")).status).toBe(404);
    expect((await post("/api/gateway/openrouter/v1/models")).status).toBe(404);
    expect((await post("/api/gateway/openrouter/v1/chat/completions/../../x")).status).toBe(404);
    expect((await call("/api/gateway/openrouter/v1/chat/completions", { auth: auth })).status).toBe(
      404,
    );
    const noKey = await post("/api/gateway/anthropic/v1/messages");
    expect(noKey.status).toBe(404);
    expect(await noKey.json()).toEqual({ error: "no_key", provider: "anthropic" });
    expect(fake).not.toHaveBeenCalled();
    expect(
      (await call("/api/gateway/openrouter/v1/chat/completions", { method: "POST", body: chat() }))
        .status,
    ).toBe(401);
  });

  it("uses only the caller's own key", async () => {
    await withKey(1);
    const other = await signIn(2, "other");
    const fake = upstreamFake(() => new Response("{}"));
    const res = await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth: other.auth,
      json: chatRequest(),
    });
    expect(res.status).toBe(404);
    expect(fake).not.toHaveBeenCalled();
  });

  it("stops at the daily cap", async () => {
    const { auth } = await withKey();
    upstreamFake(() => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const post = () =>
      call("/api/gateway/openrouter/v1/chat/completions", {
        method: "POST",
        auth: auth,
        json: chatRequest(false),
      });
    // GATEWAY_DAILY_CALLS is 3 in the test configuration.
    for (let i = 0; i < 3; i++) expect((await post()).status).toBe(200);
    const capped = await post();
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ error: "daily_limit", limit: 3 });
  });

  it("stops at the account's own daily budget when it is under the cap", async () => {
    const { auth } = await withKey();
    upstreamFake(() => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const set = await call("/api/budget", {
      method: "PUT",
      auth,
      headers: { origin: ORIGIN },
      json: { dailyCalls: 2 },
    });
    expect(await set.json()).toMatchObject({ dailyCalls: 2, callsToday: 0, serviceDailyCalls: 3 });
    const post = () =>
      call("/api/gateway/openrouter/v1/chat/completions", {
        method: "POST",
        auth: auth,
        json: chatRequest(false),
      });
    for (let i = 0; i < 2; i++) expect((await post()).status).toBe(200);
    const capped = await post();
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ error: "daily_limit", limit: 2 });
    const now = (await (await call("/api/budget", { auth })).json()) as { callsToday: number };
    expect(now.callsToday).toBe(2);
    const used = (await (await call("/api/usage", { auth })).json()) as { dailyLimit: number };
    expect(used.dailyLimit).toBe(2);

    await call("/api/budget", {
      method: "PUT",
      auth,
      headers: { origin: ORIGIN },
      json: { dailyCalls: null },
    });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  });

  it("takes a daily limit above the default, or none, up to the server's ceiling", async () => {
    const { auth } = await withKey();
    upstreamFake(() => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const setLimit = (dailyCalls: number | null) =>
      call("/api/budget", {
        method: "PUT",
        auth,
        headers: { origin: ORIGIN },
        json: { dailyCalls },
      });
    const post = () =>
      call("/api/gateway/openrouter/v1/chat/completions", {
        method: "POST",
        auth: auth,
        json: chatRequest(false),
      });
    expect((await setLimit(20_001)).status).toBe(400);
    expect((await setLimit(-1)).status).toBe(400);
    const raised = await setLimit(5);
    expect(await raised.json()).toMatchObject({ dailyCalls: 5, maxDailyCalls: 20_000 });
    // GATEWAY_DAILY_CALLS, the default, is 3 in the test configuration.
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(200);
    expect(await (await post()).json()).toMatchObject({ error: "daily_limit", limit: 5 });
    await setLimit(0);
    expect((await post()).status).toBe(200);
    const used = (await (await call("/api/usage", { auth })).json()) as { dailyLimit: number };
    expect(used.dailyLimit).toBe(20_000);
  });

  it("forwards at most the cap of parallel calls", async () => {
    const { auth, account } = await withKey();
    const fake = upstreamFake(() =>
      Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    // GATEWAY_DAILY_CALLS is 3 in the test configuration.
    const statuses = await Promise.all(
      Array.from({ length: 10 }, () =>
        call("/api/gateway/openrouter/v1/chat/completions", {
          method: "POST",
          auth: auth,
          json: chatRequest(false),
        }).then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    expect(fake).toHaveBeenCalledTimes(3);
    expect(await scoped(db, account.id).list("gatewayCalls")).toHaveLength(3);
  });

  it("records a call whose reader cancels mid-stream", async () => {
    const { auth, account } = await withKey();
    const enc = new TextEncoder();
    let upstreamCancelled = false;
    upstreamFake(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const first = { type: "message_start", message: { usage: { input_tokens: 42 } } };
              controller.enqueue(enc.encode(`data: ${JSON.stringify(first)}\n\n`));
              // Never closes: the answer is still streaming when the client leaves.
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const ctx = createExecutionContext();
    const res = await app.fetch(
      request("/api/gateway/openrouter/v1/chat/completions", {
        method: "POST",
        auth,
        json: chatRequest(),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    await reader?.cancel();
    await waitOnExecutionContext(ctx);
    expect(upstreamCancelled).toBe(true);
    expect(await scoped(db, account.id).list("gatewayCalls")).toMatchObject([
      { status: 499, tokensIn: 42, model: "vendor/model-a" },
    ]);
  });

  it("records a call whose upstream resets mid-stream", async () => {
    const { auth, account } = await withKey();
    const enc = new TextEncoder();
    upstreamFake(() => {
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) return controller.error(new Error("connection reset"));
            sent = true;
            controller.enqueue(enc.encode('data: {"usage":{"input_tokens":7}}\n\n'));
          },
        }),
      );
    });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      request("/api/gateway/openrouter/v1/chat/completions", {
        method: "POST",
        auth,
        json: chatRequest(),
      }),
      env,
      ctx,
    );
    await expect(res.text()).rejects.toThrow();
    await waitOnExecutionContext(ctx);
    expect(await scoped(db, account.id).list("gatewayCalls")).toMatchObject([
      { status: 502, tokensIn: 7 },
    ]);
  });

  it("does not follow an upstream redirect, which would resend the key (#15)", async () => {
    const { auth, account } = await withKey();
    const fake = upstreamFake(
      () =>
        new Response("moved", {
          status: 307,
          headers: { location: "https://elsewhere.example/v1/chat/completions" },
        }),
    );
    const res = await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth: auth,
      json: chatRequest(false),
    });
    expect(fake.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_redirect", status: 307 });
    expect(res.headers.get("location")).toBeNull();
    expect(await scoped(db, account.id).list("gatewayCalls")).toMatchObject([{ status: 502 }]);
  });

  it("passes upstream errors through and records their status", async () => {
    const { auth, account } = await withKey();
    upstreamFake(() =>
      Response.json(
        { error: { message: "rate limited" } },
        { status: 429, headers: { "retry-after": "5" } },
      ),
    );
    const res = await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth: auth,
      json: chatRequest(false),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await scoped(db, account.id).list("gatewayCalls")).toMatchObject([{ status: 429 }]);
  });
});

describe("usage on a long stream", () => {
  it("finds the input count in the first event and the output count in the last", async () => {
    const { auth, account } = await withKey();
    const filler = Array.from({ length: 400 }, () => ({ delta: { text: "x".repeat(200) } }));
    upstreamFake(
      () =>
        new Response(
          sse([
            { type: "message_start", message: { usage: { input_tokens: 777, output_tokens: 1 } } },
            ...filler,
            // A count inside the answer text must not be read as usage.
            { delta: { text: 'he said \\"input_tokens\\": 999999' } },
            { type: "message_delta", usage: { output_tokens: 55 } },
          ]),
        ),
    );
    const res = await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth: auth,
      json: chatRequest(),
    });
    expect((await res.text()).length).toBeGreaterThan(80_000);
    expect(await scoped(db, account.id).list("gatewayCalls")).toMatchObject([
      { tokensIn: 777, tokensOut: 55 },
    ]);
  });
});

describe("usage view", () => {
  it("lists the caller's calls and today's count, without account ids", async () => {
    const { auth } = await withKey();
    upstreamFake(() => Response.json({ usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth: auth,
      json: chatRequest(false),
    });
    const other = await signIn(9, "z");
    const mine = (await (await call("/api/usage", { auth: auth })).json()) as {
      today: number;
      calls: object[];
    };
    expect(mine.today).toBe(1);
    expect(mine.calls).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toContain("accountId");
    const theirs = (await (await call("/api/usage", { auth: other.auth })).json()) as {
      calls: object[];
    };
    expect(theirs.calls).toEqual([]);
  });
});

describe("parseUsage", () => {
  it("reads OpenAI, Responses and Anthropic counts", () => {
    expect(parseUsage('{"usage":{"prompt_tokens":5,"completion_tokens":7}}')).toEqual({
      tokensIn: 5,
      tokensOut: 7,
    });
    expect(parseUsage('{"usage":{"input_tokens":9,"output_tokens":2}}')).toEqual({
      tokensIn: 9,
      tokensOut: 2,
    });
    const anthropic =
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":300,"output_tokens":1}}}\n' +
      '...\nevent: message_delta\ndata: {"usage":{"output_tokens":45}}\n';
    expect(parseUsage(anthropic)).toEqual({ tokensIn: 300, tokensOut: 45 });
    expect(parseUsage("no counts")).toEqual({ tokensIn: 0, tokensOut: 0 });
  });

  it("adds Anthropic's cache reads and writes to the input count", () => {
    const anthropic =
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":12,' +
      '"cache_creation_input_tokens":2000,"cache_read_input_tokens":30000,"output_tokens":1}}}\n' +
      '...\nevent: message_delta\ndata: {"usage":{"output_tokens":45}}\n';
    expect(parseUsage(anthropic)).toEqual({ tokensIn: 32_012, tokensOut: 45 });
    // OpenAI's cached tokens are already part of prompt_tokens.
    expect(
      parseUsage(
        '{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens":5}}',
      ),
    ).toEqual({ tokensIn: 100, tokensOut: 5 });
  });
});

describe("topLevelModel", () => {
  it("reads the request's own model, never one nested in it", () => {
    expect(
      topLevelModel(
        JSON.stringify({
          messages: [{ role: "user", content: [{ type: "x", model: "nested-a" }] }],
          tools: [{ model: "nested-b" }],
          model: "vendor/real",
        }),
      ),
    ).toBe("vendor/real");
    expect(topLevelModel(JSON.stringify({ messages: [{ model: "nested" }] }))).toBeNull();
    expect(topLevelModel("not json")).toBeNull();
    expect(topLevelModel(JSON.stringify({ model: 5 }))).toBeNull();
  });
});
