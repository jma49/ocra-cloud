import { cloudModelSchema } from "@open-cr-agent/cloud-contract";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  chatModelOf,
  NO_USAGE,
  recordCall,
  sendChat,
  takeDailyCall,
  tierModels,
} from "./chat/call.js";
import { chatEvent, ssePayloads, type Turn } from "./chat/model.js";
import { type ChatContext, makeNonce, systemPrompt } from "./chat/prompt.js";
import type { ChatMessageRow } from "./db/review-chat.js";
import type { Row } from "./db/scoped.js";
import { defer } from "./defer.js";
import { keepsFindings } from "./findings-kept.js";
import { END_STATUS, type Usage } from "./gateway.js";
import { apiError, jsonBody } from "./http.js";
import { accessToken } from "./platforms/links.js";
import { platformsOf } from "./platforms/registry.js";
import { perMinute } from "./rate.js";
import { pullOfReview, pullOnPlatform } from "./review-pull.js";
import { requireSession } from "./session.js";
import type { ReviewChatEvent, ReviewChatMessageView, ReviewChatView } from "./shared/index.js";
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

    const model = await chatModelOf(c, body.model);
    if ("refusal" in model) return model.refusal;

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

    const limited = await takeDailyCall(c);
    if (limited) {
      await unask();
      return limited;
    }
    const finish = await recordCall(c, model);
    const sent = await sendChat(model, system, turns, c.req.raw.signal);
    if ("status" in sent) {
      defer(c, Promise.all([finish(sent.status, NO_USAGE), unask()]));
      return apiError(c, "upstream_unreachable", { status: sent.status });
    }

    const payloads = ssePayloads(sent.body);
    const wire = model.route.wire;
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
