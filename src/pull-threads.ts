import { Hono } from "hono";
import { z } from "zod";
import { apiError, jsonBody } from "./http.js";
import type { CodePlatform } from "./platforms/platform.js";
import {
  type Comment,
  MAX_APPLIED_SUGGESTIONS,
  type Suggestion,
  type Thread,
  type ThreadAction,
} from "./platforms/threads.js";
import { byKind, pullRef, reach, sha } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { identityOf } from "./review-pull.js";
import { requireSession } from "./session.js";
import {
  MAX_THREAD_REPLY_CHARS,
  type PullActionOutcome,
  type PullThreadsView,
  type ReviewThreadView,
  type ThreadComment,
  type ThreadReplyRequest,
  type ThreadSuggestion,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's review threads, read live as the signed-in user, and
// their suggestions applied, threads resolved and replied to as them. Only the web
// session acts, as on the rest of the pull request's page.

export const pullThreads = new Hono<AppEnv>();

/** A platform's id for a thread or suggestion: GitHub node ids, GitLab hex and numbers. */
export const platformId = z.string().regex(/^[\w=:-]{1,160}$/);

const threadsQuery = z.object(pullRef);
const applyBody = z.object({
  ...pullRef,
  head: sha,
  suggestions: z
    .array(platformId)
    .min(1)
    .max(MAX_APPLIED_SUGGESTIONS)
    .refine((ids) => new Set(ids).size === ids.length, "a suggestion twice"),
});
const resolveBody = z.object({ ...pullRef, thread: platformId, resolved: z.boolean() });
const replyBody = z.object({
  ...pullRef,
  thread: platformId,
  body: z
    .string()
    .max(MAX_THREAD_REPLY_CHARS)
    .refine((b) => b.trim() !== "", "an empty reply"),
});

const suggestionDto = (s: Suggestion) =>
  ({
    id: s.id,
    startLine: s.startLine,
    endLine: s.endLine,
    replacement: s.replacement,
    applicable: s.applicable,
    applied: s.applied,
  }) satisfies ThreadSuggestion;

const commentDto = (c: Comment) =>
  ({
    id: c.id,
    author: c.author,
    body: c.body,
    createdAt: c.createdAt,
    suggestions: c.suggestions.map(suggestionDto),
  }) satisfies ThreadComment;

const threadDto = (t: Thread) =>
  ({
    id: t.id,
    path: t.path,
    line: t.line,
    startLine: t.startLine,
    side: t.side,
    resolved: t.resolved,
    outdated: t.outdated,
    canResolve: t.canResolve,
    comments: t.comments.map(commentDto),
  }) satisfies ReviewThreadView;

const answer = (outcome: PullActionOutcome) => ({ outcome });

/** The account's findings on the pull request that the action's comments were ocra's comments of. */
export const findingsOn = (
  platform: CodePlatform,
  ref: { repo: string; number: number },
  action: Pick<ThreadAction, "findings">,
) => {
  const identity = identityOf(platform, ref.repo)?.toLowerCase();
  return {
    identity: identity ?? "",
    number: ref.number,
    fingerprints: identity ? action.findings : [],
  };
};

pullThreads.get("/threads", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = threadsQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const listing = await platform.threads.list(token, ref.data.repo, ref.data.number);
  if (!listing) return apiError(c, "upstream_unreachable");
  return c.json({
    head: listing.head,
    threads: listing.threads.map(threadDto),
    truncated: listing.truncated,
  } satisfies PullThreadsView);
});

pullThreads.post(
  "/apply-suggestions",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(applyBody),
  async (c) => {
    const body = c.req.valid("json");
    const reached = await reach(c, byKind(body));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const action = await platform.threads.apply(token, body.repo, body.number, {
      head: body.head,
      ids: body.suggestions,
    });
    if (!action) return apiError(c, "upstream_unreachable");
    await c.var.data.findingOutcomes.markFixedOnPull(
      findingsOn(platform, body, action),
      "suggestion",
    );
    return c.json(answer(action.outcome));
  },
);

pullThreads.post(
  "/resolve-thread",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(resolveBody),
  async (c) => {
    const body = c.req.valid("json");
    const reached = await reach(c, byKind(body));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const action = await platform.threads.resolve(
      token,
      body.repo,
      body.number,
      body.thread,
      body.resolved,
    );
    if (!action) return apiError(c, "upstream_unreachable");
    await c.var.data.findingOutcomes.markThreadResolved(
      findingsOn(platform, body, action),
      body.resolved,
    );
    return c.json(answer(action.outcome));
  },
);

pullThreads.post(
  "/reply-thread",
  requireSession(["web"]),
  perMinute("platform"),
  // A character is at most 6 bytes in JSON (\u escapes), with room for the rest of the request.
  jsonBody(replyBody, { max: MAX_THREAD_REPLY_CHARS * 6 + 4096 }),
  async (c) => {
    const reply: ThreadReplyRequest = c.req.valid("json");
    const reached = await reach(c, byKind(reply));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const outcome = await platform.threads.reply(
      token,
      reply.repo,
      reply.number,
      reply.thread,
      reply.body,
    );
    if (!outcome) return apiError(c, "upstream_unreachable");
    return c.json(answer(outcome));
  },
);
