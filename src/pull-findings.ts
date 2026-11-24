import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "./http.js";
import { openAtHead } from "./pull-open-findings.js";
import { byKind, pullRef, reach, sha } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { identityOf } from "./review-pull.js";
import { fixOf } from "./reviews.js";
import { requireSession } from "./session.js";
import type { PullFindingsView, PullFindingView } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// The open findings of ocra's reviews of a pull request at the head its page
// shows, for the page to draw on the diff. A review of an earlier head
// answers none: its lines are not this diff's.

export const pullFindings = new Hono<AppEnv>();

const atHead = z.object({ ...pullRef, head: sha });

pullFindings.get("/findings", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = atHead.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { repo, number, head } = ref.data;
  const identity = identityOf(reached.platform, repo);
  const { review, open } = identity
    ? await openAtHead(c.var.data, { prRepository: identity, prNumber: number, prHeadSha: head })
    : { review: undefined, open: [] };
  if (!review) return c.json({ review: null, findings: [] } satisfies PullFindingsView);
  return c.json({
    review: { id: review.id, head },
    findings: open.map(
      (f): PullFindingView => ({
        id: f.id,
        review: f.reviewId,
        severity: f.severity,
        title: f.title,
        body: f.body,
        file: f.file,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        hasFix: fixOf(f) !== null,
        lowConfidence: f.lowConfidence,
      }),
    ),
  } satisfies PullFindingsView);
});
