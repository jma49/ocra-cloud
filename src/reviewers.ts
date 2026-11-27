import { Hono } from "hono";
import { z } from "zod";
import type { Owner } from "./codeowners.js";
import { apiError, jsonBody } from "./http.js";
import { byKind, reach } from "./pull-page.js";
import { auditPeople, login } from "./pull-people.js";
import { pullRef } from "./pull-ref.js";
import { perMinute } from "./rate.js";
import { HISTORY_DAYS, suggestReviewers } from "./reviewer-suggest.js";
import { requireSession } from "./session.js";
import type {
  CodeOwnerMatch,
  PullReviewersView,
  RequestReviewersView,
  SuggestedReviewer,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// Reviewers suggested for a pull request, read as the signed-in user
// (./reviewer-suggest.ts), and asked for as them.

export const reviewers = new Hono<AppEnv>();

const MAX_REQUESTED = 10;

const suggestQuery = z.object(pullRef);
const requestBody = z.object({
  ...pullRef,
  logins: z.array(login).min(1).max(MAX_REQUESTED),
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
  const found = await suggestReviewers(c.var.data, platform, token, repo, number);
  if (found === "not_found") return apiError(c, "not_found");
  if (found === "unreachable") return apiError(c, "upstream_unreachable");
  return c.json({
    platform: platform.kind,
    repo,
    number,
    suggestions: found.suggestions.map(suggestionDto),
    owners: ownerMatches(found.perFile),
    codeowners: found.codeowners,
    history: found.enrolled ? "repository" : "not_enrolled",
    historyDays: HISTORY_DAYS,
    truncated: found.truncated,
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
    if (outcome === "done")
      await auditPeople(c, "reviewers", { repo, number }, { add: logins, remove: [] });
    return c.json({ outcome } satisfies RequestReviewersView);
  },
);
