import { Hono } from "hono";
import { keyFor } from "./keys.js";
import { applyAuth, isProvider, matchRoute, PASS_HEADERS, providers } from "./providers.js";
import type { AppEnv } from "./types.js";

// Forwards one model call with the user's stored key. The request body goes
// upstream as sent and the answer streams back as it comes; the gateway
// reads only the model name from the request and the token counts from the
// first and last bytes of the answer. Bodies are never logged or stored.

const MAX_BODY = 8 * 1024 * 1024;
const EDGE = 16 * 1024;

export const gateway = new Hono<AppEnv>();

gateway.post("/:provider/*", async (c) => {
  const name = c.req.param("provider");
  if (!isProvider(name)) return c.json({ error: "unknown_provider" }, 404);
  const path = c.req.path.slice(`/api/gateway/${name}`.length);
  const match = matchRoute(providers[name], path);
  if (!match) return c.json({ error: "path_not_allowed" }, 404);
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > MAX_BODY) return c.json({ error: "body_too_large" }, 413);

  const data = c.var.data;
  const today = new Date(new Date().toISOString().slice(0, 10));
  const cap = Number(c.env.GATEWAY_DAILY_CALLS);
  if ((await data.countSince("gatewayCalls", today)) >= cap) {
    return c.json({ error: "daily_limit", limit: cap }, 429);
  }
  const key = await keyFor(data, c.env.MASTER_KEY, name);
  if (!key) return c.json({ error: "no_key", provider: name }, 400);

  const body = await c.req.text();
  if (body.length > MAX_BODY) return c.json({ error: "body_too_large" }, 413);
  const model = match.model ?? body.match(/(?<!\\)"model"\s*:\s*"([^"\\]{1,200})"/)?.[1] ?? null;

  const headers = new Headers({
    "content-type": c.req.header("content-type") ?? "application/json",
    accept: c.req.header("accept") ?? "*/*",
  });
  for (const h of PASS_HEADERS) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }
  applyAuth(headers, match.route.auth, key);
  const target = new URL(providers[name].base + path);
  for (const q of match.route.query ?? []) {
    const v = c.req.query(q);
    if (v !== undefined) target.searchParams.set(q, v);
  }

  const started = Date.now();
  const record = (status: number, usage: Usage) =>
    data.insert("gatewayCalls", {
      id: crypto.randomUUID(),
      provider: name,
      path,
      model,
      status,
      ...usage,
      ms: Date.now() - started,
    });

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: "POST", headers, body });
  } catch {
    c.executionCtx.waitUntil(record(502, { tokensIn: 0, tokensOut: 0 }));
    return c.json({ error: "upstream_unreachable" }, 502);
  }

  const out = new Headers();
  for (const h of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!upstream.body) {
    c.executionCtx.waitUntil(record(upstream.status, { tokensIn: 0, tokensOut: 0 }));
    return new Response(null, { status: upstream.status, headers: out });
  }
  const meter = usageMeter((usage) => c.executionCtx.waitUntil(record(upstream.status, usage)));
  return new Response(upstream.body.pipeThrough(meter), { status: upstream.status, headers: out });
});

export type Usage = { tokensIn: number; tokensOut: number };

/**
 * Passes the answer through unchanged, keeping its first and last EDGE
 * bytes, and reports the token counts found there when the stream ends.
 * Counts sit at the end of OpenAI-style answers and streams; Anthropic
 * streams put the input count in the first event.
 */
export function usageMeter(done: (usage: Usage) => void): TransformStream<Uint8Array, Uint8Array> {
  let head = new Uint8Array(0);
  let tail: Uint8Array[] = [];
  let tailBytes = 0;
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
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
    },
    flush() {
      const dec = new TextDecoder();
      const text = `${dec.decode(head)}\n${tail.map((c) => dec.decode(c, { stream: true })).join("")}`;
      tail = [];
      done(parseUsage(text));
    },
  });
}

export function parseUsage(text: string): Usage {
  const max = (re: RegExp) => {
    let v = 0;
    for (const m of text.matchAll(re)) v = Math.max(v, Number(m[1]));
    return v;
  };
  return {
    tokensIn: max(/"(?:prompt_tokens|input_tokens|promptTokenCount)"\s*:\s*(\d+)/g),
    tokensOut: max(/"(?:completion_tokens|output_tokens|candidatesTokenCount)"\s*:\s*(\d+)/g),
  };
}
