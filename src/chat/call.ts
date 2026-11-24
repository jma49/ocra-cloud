import type { Context } from "hono";
import { outboundFetch } from "../calls.js";
import { catalogOf } from "../catalog.js";
import { config } from "../config.js";
import type { Row } from "../db/scoped.js";
import { deadline } from "../deadline.js";
import { defer } from "../defer.js";
import {
  costOf,
  END_STATUS,
  HEADERS_TIMEOUT_MS,
  keepMost,
  NO_USAGE,
  PENDING,
  TIMED_OUT,
  type Usage,
} from "../gateway.js";
import { apiError } from "../http.js";
import { keyFor, masterKeys } from "../keyring.js";
import { applyAuth, type ChatRoute, chatRoute, type Provider } from "../providers.js";
import { retryTomorrow } from "../rate.js";
import { dailyCallLimit, type ModelRef, parseModelId } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { chatEvent, chatRequest, ssePayloads, type Turn } from "./model.js";

// A model call the console makes for the account, with its own provider
// key: it counts against the gateway's daily cap and is recorded as a
// gateway call. The prompt and the answer are never logged.

export type ChatModel = { ref: ModelRef; provider: Provider; route: ChatRoute; key: string };

/** The models of the account's tiers, the standard tier's first, without repeats. */
export function tierModels(prefs: Row<"preferences"> | undefined): string[] {
  const m = prefs?.models;
  return [...new Set([...(m?.standard ?? []), ...(m?.top ?? []), ...(m?.light ?? [])])];
}

/** `name`, else the account's standard model, with its provider, route and key; or the refusal. */
export async function chatModelOf(
  c: Context<AppEnv>,
  name: string | undefined,
): Promise<ChatModel | { refusal: Response }> {
  const data = c.var.data;
  const chosen = name ?? tierModels(await data.findOne("preferences", {}))[0];
  const ref = chosen ? parseModelId(chosen) : null;
  if (!ref) return { refusal: apiError(c, "no_key", { provider: null }) };
  const provider = catalogOf(c.env).get(ref.provider);
  if (!provider) return { refusal: apiError(c, "unknown_provider") };
  const route = chatRoute(provider);
  if (!route) return { refusal: apiError(c, "path_not_allowed") };
  const key = provider.sharedKey ?? (await keyFor(data, masterKeys(c.env), ref.provider));
  if (!key) return { refusal: apiError(c, "no_key", { provider: ref.provider }) };
  return { ref, provider, route, key };
}

/** Takes one of the day's calls; the refusal when none is left. */
export async function takeDailyCall(c: Context<AppEnv>): Promise<Response | null> {
  const data = c.var.data;
  const cap = config(c.env).gatewayDailyCalls;
  if (await data.takeCall(cap)) return null;
  retryTomorrow(c);
  const own = (await data.findOne("budgets", {}))?.dailyCalls;
  return apiError(c, "daily_limit", { limit: dailyCallLimit(own, cap) });
}

/** A gateway call recorded as pending; `finish` records how it ended. */
export async function recordCall(c: Context<AppEnv>, model: ChatModel) {
  const data = c.var.data;
  const id = await data.insert("gatewayCalls", {
    provider: model.ref.provider,
    path: model.route.path,
    model: model.ref.model,
    status: PENDING,
    origin: "console",
    sessionId: c.var.session.sessionId,
  });
  const started = Date.now();
  return (status: number, usage: Usage) =>
    data.update("gatewayCalls", id, {
      status,
      ...usage,
      costUsd: costOf(model.provider.prices, model.ref.model, usage),
      ms: Date.now() - started,
    });
}

/**
 * Sends the streamed request; the answer, or why it failed as a gateway
 * status, with `answered` when that status is the provider's own.
 */
export async function sendChat(
  model: ChatModel,
  system: string,
  turns: readonly Turn[],
  client: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array> } | { status: number; answered: boolean }> {
  const request = chatRequest(model.route.wire, model.ref.model, system, turns);
  const headers = new Headers({
    "content-type": "application/json",
    accept: "text/event-stream",
    ...request.headers,
  });
  applyAuth(headers, model.route.auth, model.key);
  const clock = deadline(HEADERS_TIMEOUT_MS, client);
  let upstream: Response;
  try {
    upstream = await outboundFetch(new URL(model.provider.base + model.route.path), {
      method: "POST",
      headers,
      body: request.body,
      redirect: "manual",
      signal: clock.signal,
    });
  } catch {
    const status = client.aborted ? END_STATUS.cancelled : clock.timedOut() ? TIMED_OUT : 502;
    return { status, answered: false };
  } finally {
    clock.clear();
  }
  if (upstream.status !== 200 || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    return { status: upstream.status === 200 ? 502 : upstream.status, answered: true };
  }
  return { body: upstream.body };
}

/** The refusal for a request that got no answer, with the provider's status when it gave one. */
export const unreachable = (c: Context<AppEnv>, sent: { status: number; answered: boolean }) =>
  apiError(c, "upstream_unreachable", sent.answered ? { status: sent.status } : {});

/**
 * One whole answer, read to its end or to `maxChars`: the day's call is
 * taken first and the call recorded; the refusal when the model gave none.
 */
export async function completeChat(
  c: Context<AppEnv>,
  model: ChatModel,
  system: string,
  turns: readonly Turn[],
  maxChars: number,
): Promise<{ text: string } | { refusal: Response }> {
  const limited = await takeDailyCall(c);
  if (limited) return { refusal: limited };
  const finish = await recordCall(c, model);
  const sent = await sendChat(model, system, turns, c.req.raw.signal);
  if ("status" in sent) {
    defer(c, finish(sent.status, NO_USAGE));
    return { refusal: unreachable(c, sent) };
  }
  const payloads = ssePayloads(sent.body);
  const usage: Usage = { ...NO_USAGE };
  let text = "";
  let failed = false;
  try {
    for (;;) {
      const payload = await payloads.next();
      if (payload === null) break;
      const event = chatEvent(model.route.wire, payload);
      keepMost(usage, event.usage);
      if (event.failed) {
        failed = true;
        break;
      }
      text += event.text.slice(0, maxChars - text.length);
      if (text.length >= maxChars) break;
    }
  } catch {
    failed = true;
  } finally {
    await payloads.cancel();
  }
  const answered = !failed && text.trim() !== "";
  await finish(answered ? 200 : END_STATUS.failed, usage);
  return answered ? { text } : { refusal: apiError(c, "upstream_unreachable") };
}
