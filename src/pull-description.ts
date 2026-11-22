import { Hono } from "hono";
import { z } from "zod";
import { draftSection, withSection } from "./description-draft.js";
import { apiError, jsonBody } from "./http.js";
import { type CodePlatform, repoIdentity } from "./platforms/platform.js";
import { byKind, pullRef, reach, sha } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import {
  MAX_DESCRIPTION_CHARS,
  type PullActionOutcome,
  type PullDescriptionDraftView,
  type PullDescriptionRequest,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// "Write the PR description" (docs/self-hosting.md): a draft from ocra's
// stored review of the pull request, of its head now or else the newest,
// built without a model (./description-draft.ts), and the user's edit of
// it saved to the platform as them, only on the head they drafted on.

export const pullDescription = new Hono<AppEnv>();

const draftQuery = z.object(pullRef);
const saveBody = z.object({
  ...pullRef,
  head: sha,
  body: z.string().max(MAX_DESCRIPTION_CHARS),
});

/** The CLI's name for the repository, or null for one the platform's address cannot name. */
function identityOf(platform: CodePlatform, repo: string): string | null {
  try {
    return repoIdentity(platform, repo);
  } catch {
    return null;
  }
}

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
    const sharing = c.var.session.account.shareFindings;
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
        createdAt: review.createdAt.toISOString(),
      },
    } satisfies PullDescriptionDraftView);
  },
);

pullDescription.post(
  "/description",
  requireSession(["web"]),
  perMinute("platform"),
  // A character is at most 6 bytes in JSON (\u escapes), with room for the rest of the request.
  jsonBody(saveBody, { max: MAX_DESCRIPTION_CHARS * 6 + 4096 }),
  async (c) => {
    const edit: PullDescriptionRequest = c.req.valid("json");
    const reached = await reach(c, byKind(edit));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const outcome = await platform.actions.setDescription(token, edit.repo, edit.number, edit);
    if (!outcome) return apiError(c, "upstream_unreachable");
    return c.json({ outcome } satisfies { outcome: PullActionOutcome });
  },
);
