import { Hono } from "hono";
import { z } from "zod";
import {
  CODEOWNERS_PATHS,
  MAX_CODEOWNERS_BYTES,
  type Owner,
  ownersOfPath,
  parseCodeOwners,
} from "./codeowners.js";
import { apiError, jsonBody } from "./http.js";
import { LOGIN } from "./platforms/reviewers.js";
import { byKind, pullRef, reach } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { pathPrefixes } from "./review-paths.js";
import { rankReviewers, withLoad } from "./reviewer-rank.js";
import { requireSession } from "./session.js";
import type {
  CodeOwnerMatch,
  PullReviewersView,
  RequestReviewersView,
  SuggestedReviewer,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// Reviewers suggested for a pull request, read as the signed-in user: the
// changed files' owners in CODEOWNERS at the base, and who reviewed the
// enrolled repository's pull requests in the last 90 days (pull_reviews),
// more for those changing the directories this one changes (pull_paths,
// kept from the review webhooks: src/auto-review/paths.ts). Nothing read
// here is stored.

export const reviewers = new Hono<AppEnv>();

const MAX_SUGGESTIONS = 5;
/** Candidates whose open review requests are read before the last cut. */
const LOAD_POOL = 8;
/** Changed files matched against CODEOWNERS. */
const MAX_FILES = 300;
const HISTORY_DAYS = 90;
const MAX_HISTORY = 50;
/** Rows of reviewer and changed directory read. */
const MAX_PATH_ROWS = 200;
const MAX_REQUESTED = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const suggestQuery = z.object(pullRef);
const requestBody = z.object({
  ...pullRef,
  logins: z.array(z.string().regex(LOGIN)).min(1).max(MAX_REQUESTED),
});

const suggestionDto = (s: SuggestedReviewer) =>
  ({
    login: s.login,
    reasons: s.reasons,
    score: s.score,
    ownedFiles: s.ownedFiles,
    recentReviews: s.recentReviews,
    reviewedPaths: s.reviewedPaths
      ? { prefix: s.reviewedPaths.prefix, pulls: s.reviewedPaths.pulls }
      : null,
    load: s.load,
    alreadyRequested: s.alreadyRequested,
  }) satisfies SuggestedReviewer;

function ownerMatches(perFile: Owner[][]): CodeOwnerMatch[] {
  const counts = new Map<string, CodeOwnerMatch>();
  for (const owners of perFile) {
    for (const o of owners) {
      const k = `${o.kind}:${o.name.toLowerCase()}`;
      const seen = counts.get(k);
      if (seen) seen.files++;
      else counts.set(k, { owner: o.name, kind: o.kind, files: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.files - a.files || (a.owner < b.owner ? -1 : 1));
}

reviewers.get("/reviewers", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = suggestQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const { repo, number } = ref.data;
  const [people, changes] = await Promise.all([
    platform.reviewers.people(token, repo, number),
    platform.changes.changes(token, repo, number, MAX_FILES),
  ]);
  if (!people || !changes) return apiError(c, "not_found");
  const repoRef = { platformRepoId: people.platformRepoId, fullName: repo };
  const locations = CODEOWNERS_PATHS[platform.kind];
  const [reads, enrolled] = await Promise.all([
    platform.files.read(token, repoRef, people.base, [...locations], MAX_CODEOWNERS_BYTES),
    c.var.data.findOne("reviewRepos", {
      platform: platform.kind,
      host: platform.host,
      platformRepoId: people.platformRepoId,
    }),
  ]);
  if (!reads) return apiError(c, "upstream_unreachable");
  const found = reads.find((r) => r.blobId !== null);
  const file = found?.bytes
    ? parseCodeOwners(new TextDecoder().decode(found.bytes), platform.kind)
    : null;
  const perFile = file ? changes.files.map((f) => ownersOfPath(file, f.path)) : [];
  const since = new Date(Date.now() - HISTORY_DAYS * DAY_MS);
  const prefixes = pathPrefixes(changes.files.flatMap((f) => [f.path, f.oldPath]));
  const [history, paths] = enrolled
    ? await Promise.all([
        c.var.data.pullFlows.reviewersSince(since, [enrolled.id], MAX_HISTORY),
        c.var.data.pullPaths.reviewersIn(since, enrolled.id, prefixes, MAX_PATH_ROWS),
      ])
    : [[], []];
  const pool = rankReviewers({
    author: people.author,
    requested: people.requested,
    owners: perFile,
    history,
    paths,
  }).slice(0, LOAD_POOL);
  const load = await platform.reviewers.load(
    token,
    pool.map((p) => p.login),
  );
  return c.json({
    platform: platform.kind,
    repo,
    number,
    suggestions: withLoad(pool, load).slice(0, MAX_SUGGESTIONS).map(suggestionDto),
    owners: ownerMatches(perFile),
    codeowners: found ? { path: found.path, read: file !== null } : null,
    history: enrolled ? "repository" : "not_enrolled",
    historyDays: HISTORY_DAYS,
    truncated: changes.truncated,
  } satisfies PullReviewersView);
});

reviewers.post(
  "/reviewers",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(requestBody),
  async (c) => {
    const { repo, number, logins } = c.req.valid("json");
    const reached = await reach(c, byKind(c.req.valid("json")));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const outcome = await platform.actions.requestReviewers(token, repo, number, logins);
    if (!outcome) return apiError(c, "upstream_unreachable");
    return c.json({ outcome } satisfies RequestReviewersView);
  },
);
