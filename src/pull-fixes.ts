import { Hono } from "hono";
import { z } from "zod";
import type { Row } from "./db/scoped.js";
import { apiError } from "./http.js";
import { linesAt, MAX_FIX_FILE_BYTES, repoFilePath } from "./platforms/fix.js";
import type { CodePlatform } from "./platforms/platform.js";
import { openAtHead } from "./pull-open-findings.js";
import { byKind, reach } from "./pull-page.js";
import { pullRef, sha } from "./pull-ref.js";
import { perMinute } from "./rate.js";
import { identityOf, pullOfReview, pullOnPlatform } from "./review-pull.js";
import { fixOf } from "./reviews.js";
import { requireSession } from "./session.js";
import { type FixProposalsView, type FixProposalView, replacementLines } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// The open findings' checked fixes (ADR-0058) of ocra's review of a pull
// request, each beside the lines it replaces, read live at the reviewed head
// as the signed-in user. Nothing read is kept; POST /pulls/apply-fix commits one.

export const pullFixes = new Hono<AppEnv>();

const atHead = z.object({ ...pullRef, head: sha });

pullFixes.get("/fixes", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = atHead.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { repo, number, head } = ref.data;
  const identity = identityOf(reached.platform, repo);
  const { review, open } = identity
    ? await openAtHead(c.var.data, { prRepository: identity, prNumber: number, prHeadSha: head })
    : { review: undefined, open: [] };
  if (!review) return c.json({ review: null, fixes: [] } satisfies FixProposalsView);
  return c.json(await proposals(reached, repo, review.id, open, head));
});

pullFixes.get("/fixes/review/:id", requireSession(["web"]), perMinute("platform"), async (c) => {
  const review = await c.var.data.get("reviews", c.req.param("id"));
  const reviewed = review && pullOfReview(review);
  if (!review || !reviewed) return apiError(c, "not_found");
  const reached = await reach(c, (p) => pullOnPlatform([p], reviewed) !== undefined);
  if ("refusal" in reached) return reached.refusal;
  const pull = pullOnPlatform([reached.platform], reviewed)?.pull ?? reviewed;
  const found = (await c.var.data.findingsOf(review.id)).filter((f) => f.status === "open");
  return c.json(await proposals(reached, pull.repo, review.id, found, reviewed.head));
});

/** The fixes of the open findings given, of the review named or of earlier ones of its head. */
async function proposals(
  reached: { platform: CodePlatform; token: string },
  repo: string,
  review: string,
  found: Row<"findings">[],
  head: string,
): Promise<FixProposalsView> {
  const open = found.flatMap((f) => {
    const fix = fixOf(f);
    return fix ? [{ f, fix, path: repoFilePath(f.file) }] : [];
  });
  const paths = [...new Set(open.flatMap((o) => (o.path ? [o.path] : [])))];
  // GitLab's API takes a project's path wherever it takes its id.
  const reads =
    paths.length === 0
      ? []
      : await reached.platform.files.read(
          reached.token,
          { platformRepoId: repo, fullName: repo },
          head,
          paths,
          MAX_FIX_FILE_BYTES,
        );
  const bytesOf = new Map((reads ?? []).map((r) => [r.path, r.bytes]));
  const fixes = open.map(({ f, fix, path }): FixProposalView => {
    const bytes = path ? bytesOf.get(path) : undefined;
    return {
      finding: f.id,
      title: f.title,
      severity: f.severity,
      file: f.file,
      startLine: fix.startLine,
      endLine: fix.endLine,
      before: (bytes && linesAt(bytes, fix)) ?? null,
      after: replacementLines(fix.replacement),
    };
  });
  return { review: { id: review, head }, fixes };
}
