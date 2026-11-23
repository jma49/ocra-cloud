import { cloudModelSchema } from "@open-cr-agent/cloud-contract";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { catalogOf } from "./catalog.js";
import { chatEvent, chatRequest, ssePayloads, type Turn } from "./chat/model.js";
import { type ChatContext, makeNonce, systemPrompt } from "./chat/prompt.js";
import { config } from "./config.js";
import type { ChatMessageRow } from "./db/review-chat.js";
import type { Row } from "./db/scoped.js";
import { deadline } from "./deadline.js";
import { defer } from "./defer.js";
import { keepsFindings } from "./findings-kept.js";
import { END_STATUS, HEADERS_TIMEOUT_MS, PENDING, TIMED_OUT, type Usage } from "./gateway.js";
import { apiError, jsonBody } from "./http.js";
import { keyFor, masterKeys } from "./keyring.js";
import { accessToken } from "./platforms/links.js";
import { platformsOf } from "./platforms/registry.js";
import { applyAuth, chatRoute } from "./providers.js";
import { perMinute, retryTomorrow } from "./rate.js";
import { pullOfReview, pullOnPlatform } from "./review-pull.js";
import { requireSession } from "./session.js";
import {
  parseModelId,
  type ReviewChatEvent,
  type ReviewChatMessageView,
  type ReviewChatView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// "Ask ocra" about one review (docs/self-hosting.md, Ask ocra): a question
// is answered by the account's own model, with its own provider key, from
// what the review stored and, with a platform connection, the pull
// request's diff read now as the user. The call counts against the
// gateway's daily cap and budget and is recorded as a gateway call; the
// prompt and the answer are never logged. The question and the answer are
// kept with the review.

export const reviewChat = new Hono<AppEnv>();

/** The most messages a review's conversation keeps: questions and answers. */
export const MAX_CHAT_MESSAGES = 100;
const MAX_QUESTION = 4_000;
/** An answer is cut here as it streams, and the model's stream cancelled. */
const MAX_ANSWER_CHARS = 16_000;
/** Earlier messages sent with a question, newest kept. */
const HISTORY = 20;

const askBody = z.object({
  message: z.string().trim().min(1).max(MAX_QUESTION),
  model: cloudModelSchema.optional(),
});

const messageDto = (m: ChatMessageRow) =>
  ({
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt.toISOString(),
  }) satisfies ReviewChatMessageView;

/** The models of the account's tiers, the standard tier's first, without repeats. */
function tierModels(prefs: Row<"preferences"> | undefined): string[] {
  const m = prefs?.models;
  return [...new Set([...(m?.standard ?? []), ...(m?.top ?? []), ...(m?.light ?? [])])];
}

/** The account's standard model, else its top or light one; null with none set. */
const defaultModel = (prefs: Row<"preferences"> | undefined): string | null =>
  tierModels(prefs)[0] ?? null;

reviewChat.get("/:id/chat", requireSession(), async (c) => {
  const data = c.var.data;
  const review = await data.get("reviews", c.req.param("id"));
  if (!review) return apiError(c, "not_found");
  const [messages, prefs] = await Promise.all([
    data.chat.latest(review.id, MAX_CHAT_MESSAGES),
    data.findOne("preferences", {}),
  ]);
  return c.json({
    messages: messages.map(messageDto),
    sharing: await keepsFindings(c),
    model: defaultModel(prefs),
    models: tierModels(prefs),
    limit: MAX_CHAT_MESSAGES,
  } satisfies ReviewChatView);
});

reviewChat.delete("/:id/chat", requireSession(), async (c) => {
  const review = await c.var.data.get("reviews", c.req.param("id"));
  if (!review) return apiError(c, "not_found");
  return c.json({
    removed: await c.var.data.removeWhere("reviewChatMessages", { reviewId: review.id }),
  });
});

/** The pull request's changes read now as the user, when the account reaches its platform. */
async function liveChanges(
  c: Context<AppEnv>,
  review: Row<"reviews">,
): Promise<ChatContext["live"]> {
  const reviewed = pullOfReview(review);
  const on = reviewed && pullOnPlatform(platformsOf(c.env, c.req.url), reviewed);
  if (!on) return null;
  const { platform, pull } = on;
  try {
    const token = await accessToken(c.var.data, c.env, platform);
    if (!token) return null;
    return (await platform.changes.patches(token, pull.repo, pull.number)) ?? "unreachable";
  } catch {
    return "unreachable";
  }
}

reviewChat.post(
  "/:id/chat",
  requireSession(),
  perMinute("gateway"),
  jsonBody(askBody, { max: 32 * 1024 }),
  async (c) => {
    const data = c.var.data;
    const body = c.req.valid("json");
    const review = await data.get("reviews", c.req.param("id"));
    if (!review) return apiError(c, "not_found");

    const name = body.model ?? defaultModel(await data.findOne("preferences", {}));
    const ref = name ? parseModelId(name) : null;
    if (!ref) return apiError(c, "no_key", { provider: null });
    const provider = catalogOf(c.env).get(ref.provider);
    if (!provider) return apiError(c, "unknown_provider");
    const route = chatRoute(provider);
    if (!route) return apiError(c, "path_not_allowed");
    const key = provider.sharedKey ?? (await keyFor(data, masterKeys(c.env), ref.provider));
    if (!key) return apiError(c, "no_key", { provider: ref.provider });

    const [history, findings, walkthrough, live] = await Promise.all([
      data.chat.latest(review.id, HISTORY),
      data.findingsOf(review.id),
      data.findOne("reviewWalkthroughs", { reviewId: review.id }),
      liveChanges(c, review),
    ]);
    const sharing = await keepsFindings(c);
    const system = systemPrompt({ review, findings, walkthrough, sharing, live }, makeNonce());
    const turns: Turn[] = [
      ...history.map((m) => ({ role: m.role, text: m.text })),
      { role: "user", text: body.message },
    ];

    // The question is kept only with room left for its answer, checked in
    // the statement that adds it; it goes again when no answer comes.
    const asked = new Date();
    const questionId = await data.chat.add(
      review.id,
      "user",
      body.message,
      asked,
      MAX_CHAT_MESSAGES - 1,
    );
    if (!questionId) return apiError(c, "memory_full", { limit: MAX_CHAT_MESSAGES });
    const unask = () => data.remove("reviewChatMessages", questionId);

    const cap = config(c.env).gatewayDailyCalls;
    if (!(await data.takeCall(cap))) {
      await unask();
      retryTomorrow(c);
      const own = (await data.findOne("budgets", {}))?.dailyCalls;
      return apiError(c, "daily_limit", { limit: own != null && own < cap ? own : cap });
    }
    const callId = await data.insert("gatewayCalls", {
      provider: ref.provider,
      path: route.path,
      model: ref.model,
      status: PENDING,
    });
    const started = Date.now();
    const finish = (status: number, usage: Usage) =>
      data.update("gatewayCalls", callId, { status, ...usage, ms: Date.now() - started });

    const request = chatRequest(route.wire, ref.model, system, turns);
    const headers = new Headers({
      "content-type": "application/json",
      accept: "text/event-stream",
      ...request.headers,
    });
    applyAuth(headers, route.auth, key);
    const client = c.req.raw.signal;
    const clock = deadline(HEADERS_TIMEOUT_MS, client);
    let upstream: Response;
    try {
      upstream = await fetch(new URL(provider.base + route.path), {
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
    const wire = route.wire;
    let answer = "";
    const usage: Usage = { ...NO_USAGE };
    let ended = false;
    /** Records the call and keeps the answer so far; without one, the question goes. */
    const end = async (how: "done" | "failed" | "cancelled") => {
      if (ended) return null;
      ended = true;
      await finish(how === "done" ? 200 : END_STATUS[how], usage);
      if (!answer.trim()) {
        await unask();
        return null;
      }
      const at = new Date(Math.max(Date.now(), asked.getTime() + 1));
      const id = await data.chat.add(review.id, "assistant", answer, at, MAX_CHAT_MESSAGES);
      return id
        ? ({ id, role: "assistant", text: answer, createdAt: at.toISOString() } as const)
        : null;
    };
    const enc = new TextEncoder();
    const sse = (e: ReviewChatEvent) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          let payload: string | null;
          try {
            payload = await payloads.next();
          } catch {
            await end("failed");
            controller.enqueue(sse({ type: "error", error: "upstream_unreachable" }));
            controller.close();
            return;
          }
          if (payload === null) {
            const message = await end("done");
            controller.enqueue(
              sse(
                message
                  ? { type: "done", message }
                  : { type: "error", error: "upstream_unreachable" },
              ),
            );
            controller.close();
            return;
          }
          const event = chatEvent(wire, payload);
          usage.tokensIn = Math.max(usage.tokensIn, event.usage.tokensIn);
          usage.tokensOut = Math.max(usage.tokensOut, event.usage.tokensOut);
          if (event.failed) {
            await payloads.cancel();
            await end("failed");
            controller.enqueue(sse({ type: "error", error: "upstream_unreachable" }));
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
  },
);

const NO_USAGE: Usage = { tokensIn: 0, tokensOut: 0 };
