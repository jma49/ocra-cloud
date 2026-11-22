import { type Context, Hono } from "hono";
import { z } from "zod";
import { issueDraft } from "./finding-issue-draft.js";
import { apiError, jsonBody } from "./http.js";
import { reach } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { pullOfReview, pullOnPlatform } from "./review-pull.js";
import { requireSession } from "./session.js";
import {
  type FindingIssueAnswer,
  type FindingIssueDraftView,
  type FindingIssueRequest,
  MAX_ISSUE_BODY_CHARS,
  MAX_ISSUE_TITLE_CHARS,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// "Open an issue" on a review's finding: a draft from the finding
// (./finding-issue-draft.ts), and the user's edit of it opened in the
// reviewed repository as them. One issue per finding: the creation is
// claimed in finding_issues first, so a second click, or two at once,
// answer the issue opened instead of opening another.

export const findingIssues = new Hono<AppEnv>();

const findingId = z.string().min(1).max(64);
const issueBody = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ISSUE_TITLE_CHARS)
    .refine((t) => !/[\p{Cc}\u2028\u2029]/u.test(t), "a title is one line"),
  body: z
    .string()
    .max(MAX_ISSUE_BODY_CHARS)
    .refine((b) => !b.includes("\0"), "a body has no NUL"),
});

/** The finding, the pull request it was found on, and the platform with the user's token there. */
async function located(c: Context<AppEnv>) {
  const id = findingId.safeParse(c.req.param("id"));
  const finding = id.success ? await c.var.data.get("findings", id.data) : undefined;
  const review = finding && (await c.var.data.get("reviews", finding.reviewId));
  const reviewed = review && pullOfReview(review);
  if (!finding || !reviewed) return { refusal: apiError(c, "not_found") } as const;
  const reached = await reach(c, (p) => pullOnPlatform([p], reviewed) !== undefined);
  if ("refusal" in reached) return { refusal: reached.refusal } as const;
  const pull = pullOnPlatform([reached.platform], reviewed)?.pull ?? reviewed;
  return { ...reached, finding, pull } as const;
}

findingIssues.get("/:id/issue-draft", requireSession(["web"]), perMinute("platform"), async (c) => {
  const at = await located(c);
  if ("refusal" in at) return at.refusal;
  const { platform, finding, pull } = at;
  return c.json({
    platform: platform.kind,
    repo: pull.repo,
    ...issueDraft(platform, pull, finding),
    issue: await c.var.data.findingIssues.of(finding.id),
  } satisfies FindingIssueDraftView);
});

findingIssues.post(
  "/:id/issue",
  requireSession(["web"]),
  perMinute("platform"),
  // A character is at most 6 bytes in JSON (\u escapes), with room for the rest of the request.
  jsonBody(issueBody, { max: (MAX_ISSUE_BODY_CHARS + MAX_ISSUE_TITLE_CHARS) * 6 + 4096 }),
  async (c) => {
    const edit: FindingIssueRequest = c.req.valid("json");
    const at = await located(c);
    if ("refusal" in at) return at.refusal;
    const { platform, token, finding, pull } = at;
    const issues = c.var.data.findingIssues;
    const claim = await issues.claim(finding, new Date());
    if ("issue" in claim) return answer(c, { outcome: "done", issue: claim.issue, created: false });
    if ("pending" in claim) return answer(c, { outcome: "pending" });
    const opened = await platform.issues.open(token, pull.repo, edit).catch(() => null);
    if (opened === null || opened === "refused") {
      await issues.release(finding.id, claim.claimed);
      return opened ? answer(c, { outcome: "refused" }) : apiError(c, "upstream_unreachable");
    }
    const issue = { number: opened.number, url: platform.issues.pageUrl(pull.repo, opened.number) };
    await issues.record(finding.id, claim.claimed, issue);
    return answer(c, { outcome: "done", issue, created: true });
  },
);

const answer = (c: Context<AppEnv>, a: FindingIssueAnswer) => c.json(a);
