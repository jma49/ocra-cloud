import { type Context, Hono } from "hono";
import { z } from "zod";
import { apiError, jsonBody } from "./http.js";
import { accessToken } from "./platforms/links.js";
import { platformsOf } from "./platforms/registry.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import {
  CODE_PLATFORMS,
  MERGE_METHODS,
  PULL_VERDICTS,
  type PullActionOutcome,
  type PullFilesView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's page: its diff, read live as the signed-in user, and
// their comment, review and merge, sent to the platform as them. Nothing
// read or sent is stored. Only the web session acts: a CLI token never merges.

export const pullPage = new Hono<AppEnv>();

/** A comment as long as GitHub takes one. */
const MAX_BODY = 65_536;
const MAX_LINE_COMMENTS = 50;
/** A review's request: its note and line comments together. */
const MAX_REVIEW_BYTES = 1024 * 1024;
const SEGMENT = /^(?!\.{1,2}$)[\w.-]+$/;

/** `owner/repo` or `group/subgroup/repo`, each part a plain name. */
const repoName = z
  .string()
  .max(255)
  .refine((n) => {
    const parts = n.split("/");
    return parts.length >= 2 && parts.every((p) => SEGMENT.test(p));
  }, "not a repository path");

const pullRef = {
  platform: z.enum(CODE_PLATFORMS),
  repo: repoName,
  number: z.coerce
    .number()
    .int()
    .min(1)
    .max(2 ** 31 - 1),
};
const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const text = z.string().max(MAX_BODY);

const filesQuery = z.object(pullRef);
const commentBody = z.object({ ...pullRef, body: text.min(1) });
const reviewBody = z.object({
  ...pullRef,
  verdict: z.enum(PULL_VERDICTS),
  body: text.default(""),
  head: sha,
  comments: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        line: z.number().int().min(1),
        side: z.enum(["old", "new"]),
        body: text.min(1),
      }),
    )
    .max(MAX_LINE_COMMENTS)
    .default([]),
});
const mergeBody = z.object({ ...pullRef, method: z.enum(MERGE_METHODS), head: sha });

type Ref = z.output<typeof filesQuery>;

/** The platform and the user's token on it, or the refusal to answer. */
async function reach(c: Context<AppEnv>, ref: Ref) {
  const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === ref.platform);
  if (!platform) return { refusal: apiError(c, "not_found") } as const;
  const token = await accessToken(c.var.data, c.env, platform);
  if (!token) return { refusal: apiError(c, "github_user") } as const;
  return { platform, token } as const;
}

const answer = (c: Context<AppEnv>, outcome: PullActionOutcome | null) =>
  outcome ? c.json({ outcome }) : apiError(c, "upstream_unreachable");

pullPage.get("/files", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = filesQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, ref.data);
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
    const reached = await reach(c, body);
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
    const reached = await reach(c, c.req.valid("json"));
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
    const { repo, number, method, head } = c.req.valid("json");
    const reached = await reach(c, c.req.valid("json"));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    if (!platform.actions.mergeMethods.includes(method)) return c.json({ outcome: "refused" });
    return answer(c, await platform.actions.merge(token, repo, number, { method, head }));
  },
);
