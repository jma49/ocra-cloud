import { cloudModelSchema } from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
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
import { makeNonce, pullSystemPrompt } from "./chat/prompt.js";
import type { ChatPull, PullChatRow } from "./db/pull-chat.js";
import { keepsFindings } from "./findings-kept.js";
import { apiError, jsonBody } from "./http.js";
import { byKind, pullRef, reach } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { identityOf } from "./review-pull.js";
import { requireSession } from "./session.js";
import type { PullChatMessageView, PullChatView } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// "Ask ocra" on a pull request's page (docs/self-hosting.md, Ask ocra): a
// question about the pull request, or one of its findings or files, answered
// through ./chat/answer.ts from its diff read now as the user and ocra's
// newest review of it. The question, what it was about, and the answer are
// kept by pull request.

export const pullChat = new Hono<AppEnv>();

/** The most messages a pull request's conversation keeps: questions and answers. */
export const MAX_PULL_CHAT_MESSAGES = 100;

// A path as a diff names it: no control characters, nothing a prompt or a
// terminal could act on.
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !/\p{Cc}/u.test(p), "not a path");
const pullQuery = z.object(pullRef);
const askBody = z
  .object({
    ...pullRef,
    message: z.string().trim().min(1).max(MAX_QUESTION),
    model: cloudModelSchema.optional(),
    finding: z.string().min(1).max(64).optional(),
    file: path.optional(),
  })
  .refine((b) => !(b.finding && b.file), "a finding or a file, not both");

/** The conversation's key: platforms compare repository paths without case. */
const keyOf = (ref: z.output<typeof pullQuery>): ChatPull => ({
  platform: ref.platform,
  repo: ref.repo.toLowerCase(),
  number: ref.number,
});

const messageDto = (m: PullChatRow) =>
  ({
    id: m.id,
    role: m.role,
    text: m.text,
    finding: m.findingId,
    file: m.file,
    createdAt: m.createdAt.toISOString(),
  }) satisfies PullChatMessageView;

pullChat.get("/chat", requireSession(["web"]), async (c) => {
  const ref = pullQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const data = c.var.data;
  const [messages, prefs] = await Promise.all([
    data.pullChat.latest(keyOf(ref.data), MAX_PULL_CHAT_MESSAGES),
    data.findOne("preferences", {}),
  ]);
  return c.json({
    messages: messages.map(messageDto),
    sharing: await keepsFindings(c),
    model: defaultModel(prefs),
    models: tierModels(prefs),
    limit: MAX_PULL_CHAT_MESSAGES,
  } satisfies PullChatView);
});

pullChat.delete("/chat", requireSession(["web"]), async (c) => {
  const ref = pullQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  return c.json({
    removed: await c.var.data.removeWhere("pullChatMessages", keyOf(ref.data)),
  });
});

pullChat.post(
  "/chat",
  requireSession(["web"]),
  perMinute("gateway"),
  jsonBody(askBody, { max: 32 * 1024 }),
  async (c) => {
    const data = c.var.data;
    const body = c.req.valid("json");
    const reached = await reach(c, byKind(body));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const identity = identityOf(platform, body.repo);
    if (!identity) return apiError(c, "not_found");
    const ofPull = { prRepository: identity, prNumber: body.number };

    // A finding is asked about only when it is one of this pull request's.
    const finding = body.finding ? await data.get("findings", body.finding) : undefined;
    if (body.finding) {
      const of = finding && (await data.get("reviews", finding.reviewId));
      if (!of || of.prRepository !== identity || of.prNumber !== body.number) {
        return apiError(c, "not_found");
      }
    }
    const model = await chatModel(c, body.model);
    if ("refusal" in model) return model.refusal;

    const key = keyOf(body);
    const [history, [review], live] = await Promise.all([
      data.pullChat.latest(key, HISTORY),
      data.listNewest("reviews", 1, ofPull),
      platform.changes.patches(token, body.repo, body.number).catch(() => "unreachable" as const),
    ]);
    if (live === null) return apiError(c, "not_found");
    const [findings, walkthrough, sharing] = await Promise.all([
      review ? data.findingsOf(review.id) : [],
      review ? data.findOne("reviewWalkthroughs", { reviewId: review.id }) : undefined,
      keepsFindings(c),
    ]);
    const system = pullSystemPrompt(
      {
        pull: { platform: platform.kind, repo: body.repo, number: body.number },
        review,
        findings,
        walkthrough,
        sharing,
        live,
        focus: { finding, file: body.file ?? null },
      },
      makeNonce(),
    );
    const turns: Turn[] = [
      ...history.map((m) => ({ role: m.role, text: m.text })),
      { role: "user", text: body.message },
    ];

    // Kept only with room left for its answer, checked in the statement that adds it.
    const focus = { findingId: finding?.id ?? null, file: body.file ?? null };
    const asked = new Date();
    const cap = MAX_PULL_CHAT_MESSAGES;
    const questionId = await data.pullChat.add(key, "user", body.message, focus, asked, cap - 1);
    if (!questionId) return apiError(c, "memory_full", { limit: cap });
    return streamAnswer(c, {
      model,
      system,
      turns,
      asked,
      unask: () => data.remove("pullChatMessages", questionId),
      keep: async (answer, at) => {
        const none = { findingId: null, file: null };
        const id = await data.pullChat.add(key, "assistant", answer, none, at, cap);
        return id
          ? ({
              id,
              role: "assistant",
              text: answer,
              finding: null,
              file: null,
              createdAt: at.toISOString(),
            } as const satisfies PullChatMessageView)
          : null;
      },
    });
  },
);
