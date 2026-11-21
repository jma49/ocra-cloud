import { Hono } from "hono";
import { readText } from "./body.js";
import { catalogOf } from "./catalog.js";
import { config } from "./config.js";
import { deadline } from "./deadline.js";
import { defer } from "./defer.js";
import { apiError } from "./http.js";
import { keyFor, masterKeys } from "./keyring.js";
import { applyAuth, matchRoute, PASS_HEADERS } from "./providers.js";
import { perMinute, retryTomorrow } from "./rate.js";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// Forwards one model call with the user's stored key, or the server's own
// for a provider it holds one for. The request body goes upstream as sent
// and the answer streams back as it comes; the gateway reads only the model
// name from the request and the token counts from the first and last bytes
// of the answer. Bodies are never logged or stored.

const MAX_BODY = 8 * 1024 * 1024;
const EDGE = 16 * 1024;
/**
 * How long a provider may take to start answering (audit C5). Long: a
 * reasoning model's whole answer can come before its headers when the
 * client does not stream. Once it starts, the answer may take its time.
 */
const HEADERS_TIMEOUT_MS = 5 * 60_000;

export const gateway = new Hono<AppEnv>().use(requireSession(["web", "cli"]), perMinute("gateway"));

gateway.post("/:provider/*", async (c) => {
  const name = c.req.param("provider");
  const provider = catalogOf(c.env).get(name);
  if (!provider) return apiError(c, "unknown_provider");
  const path = c.req.path.slice(`/api/gateway/${name}`.length);
  const match = matchRoute(provider, path);
  if (!match) return apiError(c, "path_not_allowed");

  // Counted as it arrives, so a chunked body without a length is bounded too.
  const body = await readText(c, MAX_BODY);

  const data = c.var.data;
  const key = provider.sharedKey ?? (await keyFor(data, masterKeys(c.env), name));
  if (!key) return apiError(c, "no_key", { provider: name });
  const model = match.model ?? topLevelModel(body);

  // Counted against the daily cap before forwarding, in one statement, so
  // parallel calls cannot all pass. The call's row is written before
  // forwarding too, so a call that never finishes still shows in the log;
  // it is updated at the end.
  const cap = config(c.env).gatewayDailyCalls;
  if (!(await data.takeCall(cap))) {
    retryTomorrow(c);
    // Read only on a refusal: the account's own budget, when it is the smaller.
    const own = (await data.findOne("budgets", {}))?.dailyCalls;
    return apiError(c, "daily_limit", { limit: own != null && own < cap ? own : cap });
  }
  const id = await data.insert("gatewayCalls", { provider: name, path, model, status: PENDING });

  const headers = new Headers({
    "content-type": c.req.header("content-type") ?? "application/json",
    accept: c.req.header("accept") ?? "*/*",
  });
  for (const h of PASS_HEADERS) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }
  applyAuth(headers, match.route.auth, key);
  const target = new URL(provider.base + path);
  for (const q of match.route.query ?? []) {
    const v = c.req.query(q);
    if (v !== undefined) target.searchParams.set(q, v);
  }

  const started = Date.now();
  const finish = (status: number, usage: Usage) =>
    defer(c, data.update("gatewayCalls", id, { status, ...usage, ms: Date.now() - started }));

  const client = c.req.raw.signal;
  const clock = deadline(HEADERS_TIMEOUT_MS, client);
  let upstream: Response;
  try {
    // Not followed: a redirect would resend the user's key to another address.
    upstream = await fetch(target, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: clock.signal,
    });
  } catch {
    const status = client.aborted ? END_STATUS.cancelled : clock.timedOut() ? TIMED_OUT : 502;
    finish(status, { tokensIn: 0, tokensOut: 0 });
    return apiError(c, "upstream_unreachable");
  } finally {
    clock.clear();
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => {});
    finish(502, { tokensIn: 0, tokensOut: 0 });
    return apiError(c, "upstream_redirect", { status: upstream.status });
  }

  const out = new Headers();
  for (const h of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!upstream.body) {
    finish(upstream.status, { tokensIn: 0, tokensOut: 0 });
    return new Response(null, { status: upstream.status, headers: out });
  }
  const metered = usageMeter(upstream.body, (end, usage) =>
    finish(end === "done" ? upstream.status : END_STATUS[end], usage),
  );
  return new Response(metered, { status: upstream.status, headers: out });
});

/** The status of a call still being forwarded. */
const PENDING = 0;
/** Recorded when the client went away (499) or upstream broke off (502) mid-answer. */
const END_STATUS = { cancelled: 499, failed: 502 } as const;
/** Recorded when the provider did not start answering within HEADERS_TIMEOUT_MS. */
const TIMED_OUT = 504;

export type Usage = { tokensIn: number; tokensOut: number };

/**
 * Passes the answer through unchanged, keeping its first and last EDGE
 * bytes, and reports the token counts found there once, when the stream
 * ends, fails, or is cancelled by the reader. Counts sit at the end of
 * OpenAI-style answers and streams; Anthropic streams put the input count
 * in the first event.
 */
function usageMeter(
  body: ReadableStream<Uint8Array>,
  done: (end: "done" | "failed" | "cancelled", usage: Usage) => void,
): ReadableStream<Uint8Array> {
  let head = new Uint8Array(0);
  let tail: Uint8Array[] = [];
  let tailBytes = 0;
  let ended = false;
  const end = (how: "done" | "failed" | "cancelled") => {
    if (ended) return;
    ended = true;
    const dec = new TextDecoder();
    const text = `${dec.decode(head)}\n${tail.map((c) => dec.decode(c, { stream: true })).join("")}`;
    tail = [];
    done(how, parseUsage(text));
  };
  const keep = (chunk: Uint8Array) => {
    if (head.length < EDGE) {
      const take = chunk.subarray(0, EDGE - head.length);
      const next = new Uint8Array(head.length + take.length);
      next.set(head);
      next.set(take, head.length);
      head = next;
    }
    tail.push(chunk);
    tailBytes += chunk.length;
    while (tail.length > 1 && tailBytes - (tail[0]?.length ?? 0) >= EDGE) {
      tailBytes -= tail.shift()?.length ?? 0;
    }
  };
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (err) {
        end("failed");
        controller.error(err);
        return;
      }
      if (next.done) {
        end("done");
        controller.close();
        return;
      }
      keep(next.value);
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      end("cancelled");
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Input counts: OpenAI-style and Gemini prompt counts include cached tokens;
 * Anthropic's input_tokens does not, so its cache reads and writes are added.
 */
export function parseUsage(text: string): Usage {
  const max = (re: RegExp) => {
    let v = 0;
    for (const m of text.matchAll(re)) v = Math.max(v, Number(m[1]));
    return v;
  };
  return {
    tokensIn:
      max(/"(?:prompt_tokens|input_tokens|promptTokenCount)"\s*:\s*(\d+)/g) +
      max(/"cache_read_input_tokens"\s*:\s*(\d+)/g) +
      max(/"cache_creation_input_tokens"\s*:\s*(\d+)/g),
    tokensOut: max(/"(?:completion_tokens|output_tokens|candidatesTokenCount)"\s*:\s*(\d+)/g),
  };
}

/** The request's own model field; never one nested in messages or tools. */
export function topLevelModel(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const model = (parsed as { model?: unknown } | null)?.model;
  return typeof model === "string" && model.length > 0 && model.length <= 200 ? model : null;
}
