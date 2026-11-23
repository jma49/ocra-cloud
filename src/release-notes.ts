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
  type HeldReleaseDraftView,
  type HeldReleasePublishAnswer,
  type HeldReleasePublishRequest,
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
// release as them; the platform decides who may. GitLab keeps no draft
// releases, so there the edit is held here, per repository and tag, until
// the user publishes it (src/db/release-drafts.ts).

export const releaseNotesRoute = new Hono<AppEnv>();

/** Held drafts an account may keep in all, each up to MAX_RELEASE_BODY_CHARS. */
const MAX_HELD_DRAFTS = 100;
/** Held drafts of one repository the notes page lists. */
const HELD_LISTED = 50;

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
  version: z.number().int().positive().optional(),
});

const version = z.number().int().positive();
const heldPublishBody = z.object({ version });
const heldQuery = z.object({ version: z.coerce.number().pipe(version) });

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
    drafts: true,
    ...(platform.releases.drafts === "held" && {
      held: (
        await c.var.data.releaseDrafts.list({ platform: platform.kind, repo: q.repo }, HELD_LISTED)
      ).map(heldDto),
    }),
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
    const releases = platform.releases;
    if (releases.drafts === "platform") {
      const saved = await releases.saveDraft(token, body.repo, body);
      return saved ? answer(c, saved) : apiError(c, "upstream_unreachable");
    }
    const checked = await releases.checkDraft(token, body.repo, body);
    if (!checked) return apiError(c, "upstream_unreachable");
    if (checked !== "ok") return answer(c, { outcome: checked });
    const held = await c.var.data.releaseDrafts.save(
      {
        platform: platform.kind,
        repo: body.repo,
        tag: body.tag,
        target: body.target,
        name: body.name,
        body: body.body,
      },
      body.version,
      MAX_HELD_DRAFTS,
    );
    if (held === "full") {
      return apiError(c, "invalid_body", {
        issues: [{ path: ["tag"], message: `the account holds ${MAX_HELD_DRAFTS} release drafts` }],
      });
    }
    if ("stale" in held) return apiError(c, "stale", { version: held.stale });
    return answer(c, { outcome: "held", draft: heldDto(held) });
  },
);

releaseNotesRoute.post(
  "/held/:id/publish",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(heldPublishBody),
  async (c) => {
    const { version }: HeldReleasePublishRequest = c.req.valid("json");
    const id = c.req.param("id");
    const draft = await c.var.data.releaseDrafts.find(id);
    if (!draft) return apiError(c, "not_found");
    if (draft.version !== version) return apiError(c, "stale", { version: draft.version });
    const reached = await reach(c, (p) => p.kind === draft.platform);
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    if (platform.releases.drafts !== "held") return apiError(c, "not_found");
    const made = await platform.releases.release(token, draft.repo, draft);
    if (!made) return apiError(c, "upstream_unreachable");
    // A save after this read keeps its newer draft, though the release is made.
    if (made.outcome === "published") await c.var.data.releaseDrafts.remove(id, version);
    return c.json(made satisfies HeldReleasePublishAnswer);
  },
);

releaseNotesRoute.delete("/held/:id", requireSession(["web"]), async (c) => {
  const query = heldQuery.safeParse(c.req.query());
  if (!query.success) return apiError(c, "not_found");
  const removed = await c.var.data.releaseDrafts.remove(c.req.param("id"), query.data.version);
  if (removed === "removed") return c.json({ removed: true });
  return removed.stale === null
    ? apiError(c, "not_found")
    : apiError(c, "stale", { version: removed.stale });
});

const answer = (c: Context<AppEnv>, a: ReleasePublishAnswer) => c.json(a);

const heldDto = (row: {
  id: string;
  tag: string;
  target: string;
  name: string;
  body: string;
  version: number;
  updatedAt: Date;
}) =>
  ({
    id: row.id,
    tag: row.tag,
    target: row.target,
    name: row.name,
    body: row.body,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  }) satisfies HeldReleaseDraftView;
