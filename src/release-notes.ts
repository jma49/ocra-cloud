import { type Context, Hono } from "hono";
import { z } from "zod";
import { apiError, jsonBody } from "./http.js";
import { reach } from "./pull-page.js";
import { identityOf } from "./pull-verdicts.js";
import { perMinute } from "./rate.js";
import { pullView, releaseNotes } from "./release-notes-draft.js";
import { repoRef } from "./repo-head.js";
import { requireSession } from "./session.js";
import {
  MAX_RELEASE_BODY_CHARS,
  MAX_RELEASE_NAME_CHARS,
  MAX_RELEASE_PULLS,
  type ReleaseNotesView,
  type ReleasePublishAnswer,
  type ReleasePublishRequest,
  type ReleasePullView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// "Draft release notes" for a repository, read live as the signed-in user:
// the pull requests merged between two refs and notes drafted from their
// titles (./release-notes-draft.ts), then the user's edit saved as a draft
// release as them. Nothing is kept; the platform decides who may.

export const releaseNotesRoute = new Hono<AppEnv>();

/**
 * A branch, tag or commit as git allows its name, in fewer characters: no
 * `..`, `@{`, `//`, leading `-`, `/` or `.`, trailing `/`, `.` or `.lock`.
 */
const gitRef = z
  .string()
  .max(200)
  .regex(/^(?![-/.])(?!.*(\.\.|@\{|\/\/|\/\.))[A-Za-z0-9._/+-]+$/, "not a ref name")
  .refine((r) => !/(\/|\.|\.lock)$/.test(r), "not a ref name");

const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const draftQuery = z.object({
  ...repoRef,
  from: gitRef,
  to: gitRef,
  /** List refactor, chore and the other maintenance types too. */
  hidden: flag,
  /** Name the account's own review of each pull request. */
  reviews: flag,
});

const publishBody = z.object({
  ...repoRef,
  tag: gitRef,
  target: gitRef,
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_RELEASE_NAME_CHARS)
    .refine((t) => !/[\p{Cc}\u2028\u2029]/u.test(t), "a name is one line"),
  body: z
    .string()
    .max(MAX_RELEASE_BODY_CHARS)
    .refine((b) => !b.includes("\0"), "a body has no NUL"),
  draft: z.literal(true),
});

releaseNotesRoute.get("/", requireSession(["web"]), perMinute("platform"), async (c) => {
  const query = draftQuery.safeParse(c.req.query());
  if (!query.success) return apiError(c, "not_found");
  const q = query.data;
  const reached = await reach(c, (p) => p.kind === q.platform);
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const range = await platform.releases.mergedBetween(
    token,
    q.repo,
    q.from,
    q.to,
    MAX_RELEASE_PULLS,
  );
  if (range === "missing") return apiError(c, "not_found");
  if (!range) return apiError(c, "upstream_unreachable");
  const reviews = q.reviews ? await reviewsOf(c, identityOf(platform, q.repo), range.pulls) : null;
  const pulls = range.pulls.map((p) => pullView(p, reviews?.get(p.number) ?? null));
  return c.json({
    platform: platform.kind,
    repo: q.repo,
    from: q.from,
    to: q.to,
    pulls,
    truncated: range.truncated,
    body: releaseNotes({
      pulls,
      marker: platform.kind === "gitlab" ? "!" : "#",
      compareUrl: range.compareUrl,
      from: q.from,
      to: q.to,
      truncated: range.truncated,
      showHidden: q.hidden,
    }),
    drafts: platform.releases.drafts,
  } satisfies ReleaseNotesView);
});

/** The newest of the account's reviews of each pull request, by number. */
async function reviewsOf(
  c: Context<AppEnv>,
  repo: string | null,
  pulls: readonly { number: number }[],
): Promise<Map<number, NonNullable<ReleasePullView["review"]>>> {
  if (!repo) return new Map();
  const rows = await c.var.data.pullViews.verdicts(pulls.map((p) => ({ repo, number: p.number })));
  return new Map(rows.map((r) => [r.number, { verdict: r.verdict, findings: r.findings }]));
}

releaseNotesRoute.post(
  "/publish",
  requireSession(["web"]),
  perMinute("platform"),
  // A character is at most 6 bytes in JSON (\u escapes), with room for the rest.
  jsonBody(publishBody, { max: (MAX_RELEASE_BODY_CHARS + MAX_RELEASE_NAME_CHARS) * 6 + 4096 }),
  async (c) => {
    const body: ReleasePublishRequest = c.req.valid("json");
    const reached = await reach(c, (p) => p.kind === body.platform);
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    if (!platform.releases.drafts) return answer(c, { outcome: "unsupported" });
    const saved = await platform.releases.saveDraft(token, body.repo, body);
    return saved ? answer(c, saved) : apiError(c, "upstream_unreachable");
  },
);

const answer = (c: Context<AppEnv>, a: ReleasePublishAnswer) => c.json(a);
