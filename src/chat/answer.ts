import type { Context } from "hono";
import { outboundFetch } from "../calls.js";
import { catalogOf } from "../catalog.js";
import { config } from "../config.js";
import type { Row } from "../db/scoped.js";
import { deadline } from "../deadline.js";
import { defer } from "../defer.js";
import { END_STATUS, HEADERS_TIMEOUT_MS, PENDING, TIMED_OUT, type Usage } from "../gateway.js";
import { apiError } from "../http.js";
import { keyFor, masterKeys } from "../keyring.js";
import { applyAuth, chatRoute } from "../providers.js";
import { retryTomorrow } from "../rate.js";
import { dailyCallLimit, parseModelId } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { chatEvent, chatRequest, ssePayloads, type Turn } from "./model.js";

// The one model path of "Ask ocra", on a review's page and a pull request's
// alike (docs/self-hosting.md, Ask ocra): the account's own model and key,
// the call counted against the gateway's daily cap and the account's budget
// and recorded as a gateway call, the answer streamed back as server-sent
// events. Neither the prompt nor the answer is logged.

export const MAX_QUESTION = 4_000;
/** Earlier messages sent with a question, newest kept. */
export const HISTORY = 20;
/** An answer is cut here as it streams, and the model's stream cancelled. */
const MAX_ANSWER_CHARS = 16_000;

/** The models of the account's tiers, the standard tier's first, without repeats. */
export function tierModels(prefs: Row<"preferences"> | undefined): string[] {
  const m = prefs?.models;
  return [...new Set([...(m?.standard ?? []), ...(m?.top ?? []), ...(m?.light ?? [])])];
}

/** The account's standard model, else its top or light one; null with none set. */
export const defaultModel = (prefs: Row<"preferences"> | undefined): string | null =>
  tierModels(prefs)[0] ?? null;

type Provider = NonNullable<ReturnType<ReturnType<typeof catalogOf>["get"]>>;
export type ChatModel = {
  provider: string;
  model: string;
  base: Provider["base"];
  route: NonNullable<ReturnType<typeof chatRoute>>;
  key: string;
};

/** The model a question goes to and the key to call it with, or the refusal. */
export async function chatModel(
  c: Context<AppEnv>,
  named: string | undefined,
): Promise<ChatModel | { refusal: Response }> {
  const data = c.var.data;
  const name = named ?? defaultModel(await data.findOne("preferences", {}));
  const ref = name ? parseModelId(name) : null;
  if (!ref) return { refusal: apiError(c, "no_key", { provider: null }) };
  const provider = catalogOf(c.env).get(ref.provider);
  if (!provider) return { refusal: apiError(c, "unknown_provider") };
  const route = chatRoute(provider);
  if (!route) return { refusal: apiError(c, "path_not_allowed") };
  const key = provider.sharedKey ?? (await keyFor(data, masterKeys(c.env), ref.provider));
  if (!key) return { refusal: apiError(c, "no_key", { provider: ref.provider }) };
  return { provider: ref.provider, model: ref.model, base: provider.base, route, key };
}

export type ChatAnswer<M> = {
  model: ChatModel;
  system: string;
  turns: Turn[];
  /** When the kept question was asked: its answer is kept after it. */
  asked: Date;
  /** Removes the kept question, which got no answer. */
  unask: () => Promise<unknown>;
  /** Keeps the answer; the message stored, or null when there was no room. */
  keep: (answer: string, at: Date) => Promise<M | null>;
};

type ChatEvent<M> =
  | { type: "delta"; text: string }
  | { type: "done"; message: M }
  | { type: "error"; error: "upstream_unreachable" };

/** Counts the call, asks the model and streams its answer; the question was kept already. */
export async function streamAnswer<M>(c: Context<AppEnv>, ask: ChatAnswer<M>): Promise<Response> {
  const data = c.var.data;
  const { model, unask } = ask;
  const cap = config(c.env).gatewayDailyCalls;
  if (!(await data.takeCall(cap))) {
    await unask();
    retryTomorrow(c);
    const own = (await data.findOne("budgets", {}))?.dailyCalls;
    return apiError(c, "daily_limit", { limit: dailyCallLimit(own, cap) });
  }
  const callId = await data.insert("gatewayCalls", {
    provider: model.provider,
    path: model.route.path,
    model: model.model,
    status: PENDING,
  });
  const started = Date.now();
  const finish = (status: number, usage: Usage) =>
    data.update("gatewayCalls", callId, { status, ...usage, ms: Date.now() - started });

  const request = chatRequest(model.route.wire, model.model, ask.system, ask.turns);
  const headers = new Headers({
    "content-type": "application/json",
    accept: "text/event-stream",
    ...request.headers,
  });
  applyAuth(headers, model.route.auth, model.key);
  const client = c.req.raw.signal;
  const clock = deadline(HEADERS_TIMEOUT_MS, client);
  let upstream: Response;
  try {
    upstream = await outboundFetch(new URL(model.base + model.route.path), {
      method: "POST",
      headers,
      body: request.body,
      redirect: "manual",
      signal: clock.signal,
    });
  } catch {
    const status = client.aborted ? END_STATUS.cancelled : clock.timedOut() ? TIMED_OUT : 502;
    defer(c, Promise.all([finish(status, NO_USAGE), unask()]));
    return apiError(c, "upstream_unreachable");
  } finally {
    clock.clear();
  }
  if (upstream.status !== 200 || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    defer(
      c,
      Promise.all([finish(upstream.status === 200 ? 502 : upstream.status, NO_USAGE), unask()]),
    );
    return apiError(c, "upstream_unreachable", { status: upstream.status });
  }

  const payloads = ssePayloads(upstream.body);
  const wire = model.route.wire;
  let answer = "";
  const usage: Usage = { ...NO_USAGE };
  let ended = false;
  /** Records the call and keeps the answer so far; without one, the question goes. */
  const end = async (how: "done" | "failed" | "cancelled"): Promise<M | null> => {
    if (ended) return null;
    ended = true;
    await finish(how === "done" ? 200 : END_STATUS[how], usage);
    if (!answer.trim()) {
      await unask();
      return null;
    }
    return ask.keep(answer, new Date(Math.max(Date.now(), ask.asked.getTime() + 1)));
  };
  const enc = new TextEncoder();
  const sse = (e: ChatEvent<M>) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);
  const failed = sse({ type: "error", error: "upstream_unreachable" });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let payload: string | null;
        try {
          payload = await payloads.next();
        } catch {
          await end("failed");
          controller.enqueue(failed);
          controller.close();
          return;
        }
        if (payload === null) {
          const message = await end("done");
          controller.enqueue(message ? sse({ type: "done", message }) : failed);
          controller.close();
          return;
        }
        const event = chatEvent(wire, payload);
        usage.tokensIn = Math.max(usage.tokensIn, event.usage.tokensIn);
        usage.tokensOut = Math.max(usage.tokensOut, event.usage.tokensOut);
        if (event.failed) {
          await payloads.cancel();
          await end("failed");
          controller.enqueue(failed);
          controller.close();
          return;
        }
        if (!event.text) continue;
        const text = event.text.slice(0, MAX_ANSWER_CHARS - answer.length);
        answer += text;
        controller.enqueue(sse({ type: "delta", text }));
        if (answer.length >= MAX_ANSWER_CHARS) {
          await payloads.cancel();
          const message = await end("done");
          if (message) controller.enqueue(sse({ type: "done", message }));
          controller.close();
        }
        return;
      }
    },
    async cancel() {
      defer(c, end("cancelled"));
      await payloads.cancel();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

const NO_USAGE: Usage = { tokensIn: 0, tokensOut: 0 };
