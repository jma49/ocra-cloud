import { Hono } from "hono";
import { z } from "zod";
import type { Row } from "./db/scoped.js";
import { apiError } from "./http.js";
import { openBefore, outdatedOf } from "./pull-earlier-findings.js";
import { openAtHead } from "./pull-open-findings.js";
import { byKind, pullRef, reach, sha } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { identityOf } from "./review-pull.js";
import { fixOf } from "./reviews.js";
import { requireSession } from "./session.js";
import type {
  EarlierFindingsView,
  EarlierFindingView,
  PullFindingsView,
  PullFindingView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// The open findings of ocra's reviews of a pull request at the head its page
// shows, for the page to draw on the diff. A review of an earlier head
// answers none there: its lines are not this diff's; /findings/earlier lists
// those apart, each marked outdated once its lines changed.

export const pullFindings = new Hono<AppEnv>();

const atHead = z.object({ ...pullRef, head: sha });

/** Past this a file is not read to tell whether a finding's lines changed. */
const MAX_FILE_BYTES = 1024 * 1024;

const findingDto = (f: Row<"findings">): PullFindingView => ({
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
});

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
    findings: open.map(findingDto),
  } satisfies PullFindingsView);
});

pullFindings.get("/findings/earlier", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = atHead.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const { repo, number, head } = ref.data;
  const identity = identityOf(platform, repo);
  const earlier = identity
    ? await openBefore(c.var.data, { prRepository: identity, prNumber: number }, head)
    : [];
  if (earlier.length === 0) return c.json({ findings: [] } satisfies EarlierFindingsView);
  const where = await platform.contents.head(token, repo);
  const outdated = await outdatedOf(earlier, head, (commit, paths) =>
    where
      ? platform.files.read(
          token,
          { platformRepoId: where.platformRepoId, fullName: where.fullName },
          commit,
          paths,
          MAX_FILE_BYTES,
        )
      : Promise.resolve(null),
  );
  return c.json({
    findings: earlier.map(
      ({ finding, head: at }, i): EarlierFindingView => ({
        ...findingDto(finding),
        head: at,
        outdated: outdated[i] ?? false,
      }),
    ),
  } satisfies EarlierFindingsView);
});
