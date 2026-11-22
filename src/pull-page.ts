import { type Context, Hono } from "hono";
import { z } from "zod";
import { apiError, jsonBody } from "./http.js";
import { fixMessage, repoFilePath } from "./platforms/fix.js";
import { accessToken } from "./platforms/links.js";
import type { CodePlatform } from "./platforms/platform.js";
import { platformsOf } from "./platforms/registry.js";
import {
  MAX_SUGGESTION_CHARS,
  MAX_SUGGESTION_LINES,
  MAX_SUGGESTION_RANGE,
  suggestionLineCount,
  withSuggestion,
} from "./platforms/suggestions.js";
import { perMinute } from "./rate.js";
import { pullOfReview, pullOnPlatform } from "./review-pull.js";
import { fixOf } from "./reviews.js";
import { requireSession } from "./session.js";
import {
  CODE_PLATFORMS,
  MERGE_METHODS,
  type MergeMethod,
  type MergeQueueView,
  PULL_VERDICTS,
  type PullActionOutcome,
  type PullFilesView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's page: its diff, read live as the signed-in user, and
// their comment, review, merge, merge queue entry and commit of a finding's
// fix, sent to the platform as them. Nothing read or sent is stored. Only
// the web session acts: a CLI token never merges.

export const pullPage = new Hono<AppEnv>();

/** A comment as long as GitHub takes one. */
const MAX_BODY = 65_536;
const MAX_LINE_COMMENTS = 50;
/** A review's request: its note and line comments together. */
const MAX_REVIEW_BYTES = 1024 * 1024;
const SEGMENT = /^(?!\.{1,2}$)[\w.-]+$/;

/** `owner/repo` or `group/subgroup/repo`, each part a plain name. */
export const repoName = z
  .string()
  .max(255)
  .refine((n) => {
    const parts = n.split("/");
    return parts.length >= 2 && parts.every((p) => SEGMENT.test(p));
  }, "not a repository path");

export const pullRef = {
  platform: z.enum(CODE_PLATFORMS),
  repo: repoName,
  number: z.coerce
    .number()
    .int()
    .min(1)
    .max(2 ** 31 - 1),
};
export const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const text = z.string().max(MAX_BODY);

const filesQuery = z.object(pullRef);
const commentBody = z.object({ ...pullRef, body: text.min(1) });
/** A line or range comment, which may carry a suggestion for the new lines it is on. */
const lineComment = z
  .object({
    path: z.string().min(1).max(4096),
    line: z.number().int().min(1),
    side: z.enum(["old", "new"]),
    body: text.default(""),
    startLine: z.number().int().min(1).optional(),
    suggestion: z
      .string()
      .max(MAX_SUGGESTION_CHARS)
      .refine((t) => !t.includes("\0") && suggestionLineCount(t) <= MAX_SUGGESTION_LINES)
      .optional(),
  })
  .refine((c) => c.body.trim() !== "" || c.suggestion !== undefined, "an empty comment")
  .refine(
    (c) =>
      c.startLine === undefined ||
      (c.startLine <= c.line && c.line - c.startLine <= MAX_SUGGESTION_RANGE),
    "not a range",
  )
  .refine((c) => c.suggestion === undefined || c.side === "new", "a suggestion on removed lines")
  .refine(
    (c) =>
      c.suggestion === undefined ||
      withSuggestion("gitlab", c.body, c.suggestion, MAX_SUGGESTION_RANGE).length <= MAX_BODY,
    "too long with its suggestion",
  );
const reviewBody = z.object({
  ...pullRef,
  verdict: z.enum(PULL_VERDICTS),
  body: text.default(""),
  head: sha,
  comments: z.array(lineComment).max(MAX_LINE_COMMENTS).default([]),
});
const mergeBody = z.object({ ...pullRef, method: z.enum(MERGE_METHODS), head: sha });
const queueBody = z.object({ ...pullRef, head: sha });
const dequeueBody = z.object(pullRef);
const fixBody = z.object({ finding: z.string().min(1).max(64) });

type Ref = z.output<typeof filesQuery>;

/** One merge as the user, of the head they saw; a method the platform has not is refused unsent. */
export async function mergeOne(
  platform: CodePlatform,
  token: string,
  pull: { repo: string; number: number; method: MergeMethod; head: string },
): Promise<PullActionOutcome | null> {
  if (!platform.actions.mergeMethods.includes(pull.method)) return "refused";
  const { method, head } = pull;
  return platform.actions.merge(token, pull.repo, pull.number, { method, head });
}

/** The platform and the user's token on it, or the refusal to answer. */
export async function reach(c: Context<AppEnv>, which: (p: CodePlatform) => boolean) {
  const platform = platformsOf(c.env, c.req.url).find(which);
  if (!platform) return { refusal: apiError(c, "not_found") } as const;
  const token = await accessToken(c.var.data, c.env, platform);
  if (!token) return { refusal: apiError(c, "github_user") } as const;
  return { platform, token } as const;
}

export const byKind = (ref: Ref) => (p: CodePlatform) => p.kind === ref.platform;

const answer = (c: Context<AppEnv>, outcome: PullActionOutcome | null) =>
  outcome ? c.json({ outcome }) : apiError(c, "upstream_unreachable");

pullPage.get("/files", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = filesQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const patches = await platform.changes.patches(token, ref.data.repo, ref.data.number);
  if (!patches) return apiError(c, "not_found");
  return c.json({
    platform: platform.kind,
    repo: ref.data.repo,
    number: ref.data.number,
    base: patches.base,
    head: patches.head,
    updatedAt: patches.updatedAt,
    files: patches.files.map((f) => ({
      path: f.path,
      oldPath: f.oldPath,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    })),
    truncated: patches.truncated,
    verdicts: [...platform.actions.verdicts],
    mergeMethods: [...platform.actions.mergeMethods],
  } satisfies PullFilesView);
});

pullPage.post(
  "/comment",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(commentBody, { max: MAX_BODY * 2 }),
  async (c) => {
    const body = c.req.valid("json");
    const reached = await reach(c, byKind(body));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    return answer(c, await platform.actions.comment(token, body.repo, body.number, body.body));
  },
);

pullPage.post(
  "/review",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(reviewBody, { max: MAX_REVIEW_BYTES }),
  async (c) => {
    const { repo, number, verdict, body, head, comments } = c.req.valid("json");
    const reached = await reach(c, byKind(c.req.valid("json")));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    if (!platform.actions.verdicts.includes(verdict)) return c.json({ outcome: "refused" });
    const review = { verdict, body, head, comments };
    return answer(c, await platform.actions.review(token, repo, number, review));
  },
);

pullPage.post(
  "/merge",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(mergeBody),
  async (c) => {
    const body = c.req.valid("json");
    const reached = await reach(c, byKind(body));
    if ("refusal" in reached) return reached.refusal;
    return answer(c, await mergeOne(reached.platform, reached.token, body));
  },
);

pullPage.get("/queue", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = filesQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const view = await platform.queue.status(token, ref.data.repo, ref.data.number);
  if (!view) return apiError(c, "upstream_unreachable");
  return c.json({
    enabled: view.enabled,
    entry: view.entry && { state: view.entry.state, position: view.entry.position },
  } satisfies MergeQueueView);
});

pullPage.post(
  "/enqueue",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(queueBody),
  async (c) => {
    const { repo, number, head } = c.req.valid("json");
    const reached = await reach(c, byKind(c.req.valid("json")));
    if ("refusal" in reached) return reached.refusal;
    return answer(c, await reached.platform.queue.enqueue(reached.token, repo, number, head));
  },
);

pullPage.post(
  "/dequeue",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(dequeueBody),
  async (c) => {
    const { repo, number } = c.req.valid("json");
    const reached = await reach(c, byKind(c.req.valid("json")));
    if ("refusal" in reached) return reached.refusal;
    return answer(c, await reached.platform.queue.dequeue(reached.token, repo, number));
  },
);

pullPage.post(
  "/apply-fix",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(fixBody),
  async (c) => {
    const data = c.var.data;
    const finding = await data.get("findings", c.req.valid("json").finding);
    const fix = finding && fixOf(finding);
    const review = fix && (await data.get("reviews", finding.reviewId));
    const reviewed = review && pullOfReview(review);
    if (!finding || !fix || !reviewed) return apiError(c, "not_found");
    const path = repoFilePath(finding.file);
    if (!path) return c.json({ outcome: "not_applicable" satisfies PullActionOutcome });
    const reached = await reach(c, (p) => pullOnPlatform([p], reviewed) !== undefined);
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const pull = pullOnPlatform([platform], reviewed)?.pull ?? reviewed;
    // The fix's lines are the reviewed head's: a pull request that moved since is head_moved,
    // which also keeps a second click from committing it twice.
    const outcome = await platform.actions.applyFix(token, pull.repo, pull.number, {
      path,
      head: pull.head,
      fixes: [fix],
      message: fixMessage(finding.title),
    });
    if (outcome === "done") {
      await data.decide([finding.id], {
        status: "fixed",
        reason: null,
        note: null,
        decidedAt: new Date(),
      });
    }
    return answer(c, outcome);
  },
);
