import { Hono } from "hono";
import { z } from "zod";
import { draftSection, withSection } from "./description-draft.js";
import { keepsFindings } from "./findings-kept.js";
import { apiError } from "./http.js";
import { byKind, reach } from "./pull-page.js";
import { pullRef } from "./pull-ref.js";
import { perMinute } from "./rate.js";
import { identityOf } from "./review-pull.js";
import { requireSession } from "./session.js";
import type { PullDescriptionDraftView } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// "Write the PR description" (docs/self-hosting.md): a draft from ocra's
// stored review of the pull request, of its head now or else the newest,
// built without a model (./description-draft.ts). The user's edit of it is
// saved with POST /api/pulls/details (./pull-details.ts).

export const pullDescription = new Hono<AppEnv>();

const draftQuery = z.object(pullRef);

pullDescription.get(
  "/description-draft",
  requireSession(["web"]),
  perMinute("platform"),
  async (c) => {
    const ref = draftQuery.safeParse(c.req.query());
    if (!ref.success) return apiError(c, "not_found");
    const reached = await reach(c, byKind(ref.data));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const { repo, number } = ref.data;
    const identity = identityOf(platform, repo);
    if (!identity) return apiError(c, "not_found");
    const now = await platform.actions.description(token, repo, number);
    if (!now) return apiError(c, "not_found");
    const data = c.var.data;
    const pull = { prRepository: identity, prNumber: number };
    const [atHead] = await data.listNewest("reviews", 1, { ...pull, prHeadSha: now.head });
    const review = atHead ?? (await data.listNewest("reviews", 1, pull))[0];
    if (!review?.prHeadSha) {
      return c.json({ ...now, draft: null, review: null } satisfies PullDescriptionDraftView);
    }
    const sharing = await keepsFindings(c);
    const [walkthrough, findings] = await Promise.all([
      data.findOne("reviewWalkthroughs", { reviewId: review.id }),
      sharing ? data.findingsOf(review.id) : [],
    ]);
    const current = review.prHeadSha === now.head;
    const section = draftSection({ review, walkthrough, findings, sharing, current });
    return c.json({
      head: now.head,
      body: now.body,
      draft: withSection(now.body, section),
      review: {
        id: review.id,
        head: review.prHeadSha,
        current,
        complete: review.complete,
        createdAt: review.createdAt.toISOString(),
      },
    } satisfies PullDescriptionDraftView);
  },
);
