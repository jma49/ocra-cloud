import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "./http.js";
import { openAtHead } from "./pull-open-findings.js";
import { byKind, pullRef, reach, sha } from "./pull-page.js";
import { numberVersions } from "./pull-versions/merge.js";
import { versionSources } from "./pull-versions.js";
import { perMinute } from "./rate.js";
import { identityOf } from "./review-pull.js";
import { requireSession } from "./session.js";
import type { PullReviewChangesView, PullSinceState } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// How far a pull request moved since ocra last reviewed it: commits and
// versions after the reviewed head, read live as the user, and whether the
// review left findings open, so the page can offer to review only the
// changes on a repository reviewed only when asked. Nothing read is stored.

export const pullReviewChanges = new Hono<AppEnv>();

const query = z.object(pullRef);

pullReviewChanges.get(
  "/review-changes",
  requireSession(["web"]),
  perMinute("platform"),
  async (c) => {
    const ref = query.safeParse(c.req.query());
    if (!ref.success) return apiError(c, "not_found");
    const reached = await reach(c, byKind(ref.data));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const { repo, number } = ref.data;
    const identity = identityOf(platform, repo);
    const [pull, sources, [review], enrolled] = await Promise.all([
      platform.changes.changes(token, repo, number, 0),
      versionSources(c, platform, token, repo, number),
      identity
        ? c.var.data.listNewest("reviews", 1, { prRepository: identity, prNumber: number })
        : Promise.resolve([]),
      c.var.data.findOne("reviewRepos", {
        platform: platform.kind,
        host: platform.host,
        fullName: repo,
      }),
    ]);
    if (!pull) return apiError(c, "not_found");
    const head = pull.head.toLowerCase();
    const reviewedAt = review?.prHeadSha ?? null;
    const reviewed = reviewedAt?.toLowerCase() ?? null;
    const view = {
      platform: platform.kind,
      repo,
      number,
      head,
      automatic: enrolled ? enrolled.automatic : null,
    };
    if (!review || !identity || !reviewedAt || !reviewed || !sha.safeParse(reviewed).success) {
      return c.json({
        ...view,
        review: null,
        state: "none",
        commits: null,
        versions: null,
        openFindings: 0,
        reviewChanges: false,
      } satisfies PullReviewChangesView);
    }
    const [{ open }, diff] = await Promise.all([
      openAtHead(c.var.data, { prRepository: identity, prNumber: number, prHeadSha: reviewedAt }),
      reviewed === head ? null : platform.since.diff(token, repo, reviewed, head),
    ]);
    const state: PullSinceState = reviewed === head ? "same" : (diff?.state ?? "unavailable");
    const { versions } = numberVersions(sources.kept, sources.listed, head, new Date());
    const at = versions.findIndex((v) => v.head === reviewed);
    return c.json({
      ...view,
      review: { id: review.id, head: reviewed, at: review.createdAt.toISOString() },
      state,
      commits: state === "same" ? 0 : diff?.state === "changes" ? diff.commits : null,
      versions: state === "same" ? 0 : at === -1 ? null : versions.length - 1 - at,
      openFindings: open.length,
      reviewChanges:
        enrolled !== undefined &&
        !enrolled.automatic &&
        open.length > 0 &&
        (state === "changes" || state === "rebased"),
    } satisfies PullReviewChangesView);
  },
);
