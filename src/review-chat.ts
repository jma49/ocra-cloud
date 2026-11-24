import { cloudModelSchema } from "@open-cr-agent/cloud-contract";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  chatModel,
  defaultModel,
  HISTORY,
  MAX_QUESTION,
  streamAnswer,
  tierModels,
} from "./chat/answer.js";
import type { Turn } from "./chat/model.js";
import { type ChatContext, makeNonce, systemPrompt } from "./chat/prompt.js";
import type { ChatMessageRow } from "./db/review-chat.js";
import type { Row } from "./db/scoped.js";
import { keepsFindings } from "./findings-kept.js";
import { apiError, jsonBody } from "./http.js";
import { accessToken } from "./platforms/links.js";
import { platformsOf } from "./platforms/registry.js";
import { perMinute } from "./rate.js";
import { pullOfReview, pullOnPlatform } from "./review-pull.js";
import { requireSession } from "./session.js";
import type { ReviewChatMessageView, ReviewChatView } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// "Ask ocra" about one review (docs/self-hosting.md, Ask ocra): a question
// is answered through ./chat/answer.ts from what the review stored and, with
// a platform connection, the pull request's diff read now as the user. The
// question and the answer are kept with the review.

export const reviewChat = new Hono<AppEnv>();

/** The most messages a review's conversation keeps: questions and answers. */
export const MAX_CHAT_MESSAGES = 100;

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
    const model = await chatModel(c, body.model);
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
    return streamAnswer(c, {
      model,
      system,
      turns,
      asked,
      unask: () => data.remove("reviewChatMessages", questionId),
      keep: async (answer, at) => {
        const id = await data.chat.add(review.id, "assistant", answer, at, MAX_CHAT_MESSAGES);
        return id
          ? ({ id, role: "assistant", text: answer, createdAt: at.toISOString() } as const)
          : null;
      },
    });
  },
);
