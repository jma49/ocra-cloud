import {
  MAX_FINDINGS,
  MAX_REVIEWERS,
  REVIEWER_ID,
  reviewUploadSchema,
} from "@open-cr-agent/cloud-contract";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import { reviewedEvent } from "./automations/reviewed.js";
import { automate } from "./automations/run.js";
import { config } from "./config.js";
import type { FindingsOnPull } from "./db/finding-outcomes.js";
import type { Row, Scoped } from "./db/scoped.js";
import { defer } from "./defer.js";
import { platformDismissals } from "./finding-dismissals.js";
import { parseFindings } from "./findings.js";
import { keepsFindings } from "./findings-kept.js";
import { apiError, jsonBody, queryDays } from "./http.js";
import { notifyReview, outboxOf, publicOutbox } from "./notify/notify.js";
import { tellReviewBlocking } from "./notify/pull-events.js";
import { tellSpend } from "./notify/spend.js";
import { platformsOf } from "./platforms/registry.js";
import { publishReview } from "./pull-events/publish.js";
import { perMinute, retryTomorrow } from "./rate.js";
import { repoNames } from "./repositories.js";
import { pullOfReview, pullOnPlatform } from "./review-pull.js";
import { requireSession } from "./session.js";
import type { ReviewerCounts, ReviewWalkthroughView } from "./shared/index.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";
import { parseWalkthrough } from "./walkthrough.js";

// Review metadata: the CLI uploads counts after a review, the web lists them.

export const reviews = new Hono<AppEnv>();

/** An upload's largest body, in bytes. */
const MAX_UPLOAD = 600_000;
type Upload = z.output<typeof reviewUploadSchema>;

type ReviewRow = Omit<ReturnType<typeof reviewRow>, "reviewersDropped">;

/**
 * The row without what goes only with shared findings (ADR-0028): the
 * linked tasks' titles and labels, the checks' reasons, and the learnings
 * of a review that names no pull request.
 */
export function withoutSharedText(row: ReviewRow): ReviewRow {
  return {
    ...row,
    linkedTasks:
      row.linkedTasks?.map(
        (t) => t && { tracker: t.tracker, key: t.key, url: t.url, state: t.state },
      ) ?? null,
    mergeChecks: row.mergeChecks?.map((m) => m && { id: m.id, outcome: m.outcome }) ?? null,
    learnings: row.prRepository === null ? null : row.learnings,
  };
}

/** The review's row from a checked upload, and how many reviewers' counts it left out. */
export function reviewRow(u: Upload) {
  const byReviewer = Object.fromEntries(
    Object.entries(u.reviewers ?? {})
      .slice(0, MAX_REVIEWERS)
      .filter((e): e is [string, ReviewerCounts] => REVIEWER_ID.test(e[0]) && e[1] !== null),
  );
  const { critical, warning, suggestion } = u.findings;
  return {
    byReviewer: Object.keys(byReviewer).length > 0 ? byReviewer : null,
    verification: u.verification && Object.keys(u.verification).length > 0 ? u.verification : null,
    fixed: u.outcomes?.fixed ?? 0,
    dismissed: u.outcomes?.dismissed ?? 0,
    runId: u.runId,
    repoHash: u.repoHash,
    source: u.source,
    tier: u.tier,
    verdict: u.verdict,
    complete: u.complete,
    findings: critical + warning + suggestion,
    critical,
    warning,
    suggestion,
    filesReviewed: u.files.reviewed,
    filesNotReviewed: u.files.notReviewed,
    tasksCompleted: u.tasks.completed,
    tasksFailed: u.tasks.failed,
    tokensIn: u.usage.inputTokens,
    tokensOut: u.usage.outputTokens,
    costUsd: u.usage.costUsd,
    durationMs: u.durationMs,
    ocraVersion: u.ocraVersion,
    prRepository: u.pullRequest?.repository ?? null,
    prNumber: u.pullRequest?.number ?? null,
    prHeadSha: u.pullRequest?.headSha ?? null,
    // Absent stays null (not looked up, not said); an empty list stays empty.
    linkedTasks: u.linkedTasks ?? null,
    learnings: u.learnings ?? null,
    mergeChecks: u.mergeChecks ?? null,
    // How many reviewers' counts were left out, for the answer's `dropped`.
    reviewersDropped: Object.keys(u.reviewers ?? {}).length - Object.keys(byReviewer).length,
  };
}

/**
 * The earlier findings on the upload's pull request it saw fixed, each once
 * and at most the contract's MAX_FINDINGS. Its dismissed ones are not kept:
 * a dismissal on the platform names no reason, and the account's own
 * dismissals always do.
 */
function fixedOnPull(u: Upload): FindingsOnPull | null {
  const fingerprints = (u.outcomes?.fixedFingerprints ?? []).filter((f) => f !== null);
  if (!u.pullRequest || fingerprints.length === 0) return null;
  return {
    identity: u.pullRequest.repository.toLowerCase(),
    number: u.pullRequest.number,
    fingerprints: [...new Set(fingerprints)].slice(0, MAX_FINDINGS),
  };
}

// Counts are small; findings, sent only when the account shares them, are
// bounded to 256 KB of text (ADR-0028). Past MAX_UPLOAD bytes: 413.
const uploadBody = jsonBody(reviewUploadSchema, { max: MAX_UPLOAD });

reviews.post("/", requireSession(["web", "cli"]), perMinute("upload"), uploadBody, async (c) => {
  const upload = c.req.valid("json");
  const { reviewersDropped, ...counts } = reviewRow(upload);
  // Findings are kept only while the account shares them, whatever the CLI sent.
  const list = upload.findingList;
  const sharing = await keepsFindings(c);
  const row = sharing ? counts : withoutSharedText(counts);
  const parsed =
    sharing && list !== undefined
      ? parseFindings(list)
      : { rows: [], truncated: false, dropped: 0 };
  const walkthrough = sharing ? parseWalkthrough(upload.walkthrough) : undefined;
  // What was left out is reported, never silently lost (audit K-models).
  const dropped = {
    ...(parsed.dropped > 0 ? { findings: parsed.dropped } : {}),
    ...(reviewersDropped > 0 ? { reviewers: reviewersDropped } : {}),
  };
  // A run uploads once; a retry of the same run, even a concurrent one, is
  // not a second review. Uploads per UTC day and shared findings are capped
  // per account (audits S3, C1): a loop of uploads cannot fill the database
  // or use up the plan's daily writes.
  const { reviewDailyUploads: limit, reviewMaxFindings } = config(c.env);
  const stored = await c.var.data.insertReview(row, parsed.rows, {
    dailyUploads: limit,
    maxFindings: reviewMaxFindings,
  });
  if (stored.outcome === "duplicate") return c.json({ id: stored.id, duplicate: true });
  if (stored.outcome === "limited") {
    retryTomorrow(c);
    return apiError(c, "daily_limit", { limit });
  }
  const { id, findingsSkipped } = stored;
  // A retry of the run answers duplicate above, so this runs once per review.
  if (walkthrough) await c.var.data.insert("reviewWalkthroughs", { ...walkthrough, reviewId: id });
  const fixed = sharing ? fixedOnPull(upload) : null;
  if (fixed) await c.var.data.findingOutcomes.markFixedOnRereview(fixed);
  publishReview(c, id);
  defer(c, announce(c, id));
  if (row.costUsd > 0) defer(c, tellSpend(c.var.data, outboxOf(c)));
  defer(c, recheckPull(c, id));
  return c.json({
    id,
    findings: findingsSkipped ? 0 : parsed.rows.length,
    ...(parsed.truncated ? { truncated: true } : {}),
    ...(Object.keys(dropped).length > 0 ? { dropped } : {}),
    ...(findingsSkipped ? { findingsSkipped: "account_limit" } : {}),
  });
});

/** Tells the account's chats about the stored review, after the answer. */
async function announce(c: Context<AppEnv>, id: string) {
  const review = await c.var.data.get("reviews", id);
  if (!review) return;
  const consoleUrl = new URL(`/reviews/${encodeURIComponent(id)}`, c.req.url).toString();
  const platforms = platformsOf(c.env, c.req.url);
  // Its author hears of it once: as their own pull request's, where that went.
  const share = await keepsFindings(c);
  const told = await tellReviewBlocking(
    c.var.db,
    c.var.data,
    publicOutbox(c),
    review,
    platforms,
    share,
  );
  await notifyReview(c.var.data, outboxOf(c), review, platforms, consoleUrl, told, share);
  const event = await reviewedEvent(c.var.data, review, platforms, consoleUrl);
  if (event) await (await automate(c, c.var.data, event)).run;
}

/**
 * Evaluates the pre-merge checks of the reviewed pull request again, now
 * that its head has a review, when this account enrolled its repository on
 * a platform this deployment serves; a review naming any other host is not one.
 */
async function recheckPull(c: Context<AppEnv>, id: string) {
  const service = c.var.autoReview;
  const review = service?.checkPull && (await c.var.data.get("reviews", id));
  const reviewed = review && pullOfReview(review);
  const on = reviewed && pullOnPlatform(platformsOf(c.env, c.req.url), reviewed);
  if (!service?.checkPull || !on) return;
  const { platform, pull } = on;
  const repo = await c.var.data.mergeChecks.enrolledRepo(platform.kind, platform.host, pull.repo);
  if (repo) service.checkPull(c.var.data.accountId, repo.id, pull.number);
}

// One review with its findings, for the web's detail page.
reviews.get("/:id", requireSession(), async (c) => {
  const review = await c.var.data.get("reviews", c.req.param("id"));
  if (!review) return apiError(c, "not_found");
  const [list, walkthrough, issues, dismissals] = await Promise.all([
    c.var.data.findingsOf(review.id),
    c.var.data.findOne("reviewWalkthroughs", { reviewId: review.id }),
    c.var.data.findingIssues.ofReview(review.id),
    platformDismissals(c.var.data, review),
  ]);
  return c.json({
    review: listedReview(review),
    findings: list.map((f) => ({
      ...findingDto(f),
      issue: issues.get(f.id) ?? null,
      platformDismissal: dismissals.get(f.fingerprint) ?? null,
    })),
    walkthrough: walkthrough ? walkthroughDto(walkthrough) : null,
  });
});

// ocra-cloud/review-export: the uploaded counts and findings. Not a report:
// coverage, tasks and provenance were never uploaded (ADR-0028, 3).
//
// Version 2 (audit K-export) names each finding's fields as the report's
// findings[] does (docs/schema/report.v1.json in the engine): `lines`
// {start, end} and `code`, the quoted code. Version 1 put the quoted code
// in `evidence`, which in the report is a list of strings; v2 is a new
// version because that field changed. A field the report makes optional
// is left out when unknown, never null. The report's inDiff, status,
// evidence and provenance were never uploaded, so they are absent; fix is
// there when the CLI sent one, and the walkthrough beside the findings.
// Two fields are ocra Cloud's own: `redacted` (the server or the CLI
// replaced a secret-looking string with [redacted]) and `truncated` (a
// long field was cut).
const EXPORT_VERSION = 2;

type FindingRow = Awaited<ReturnType<Scoped["findingsOf"]>>[number];

/** A review as the web and the export show it; the account id stays on the server. */
function reviewDto(r: Row<"reviews">) {
  return {
    id: r.id,
    runId: r.runId,
    repoHash: r.repoHash,
    source: r.source,
    tier: r.tier,
    verdict: r.verdict,
    complete: r.complete,
    findings: r.findings,
    critical: r.critical,
    warning: r.warning,
    suggestion: r.suggestion,
    filesReviewed: r.filesReviewed,
    filesNotReviewed: r.filesNotReviewed,
    tasksCompleted: r.tasksCompleted,
    tasksFailed: r.tasksFailed,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    costUsd: r.costUsd,
    durationMs: r.durationMs,
    ocraVersion: r.ocraVersion,
    prRepository: r.prRepository,
    prNumber: r.prNumber,
    prHeadSha: r.prHeadSha,
    linkedTasks: r.linkedTasks,
    learnings: r.learnings,
    mergeChecks: r.mergeChecks,
    byReviewer: r.byReviewer,
    verification: r.verification,
    fixed: r.fixed,
    dismissed: r.dismissed,
    createdAt: r.createdAt,
  } satisfies Omit<Row<"reviews">, "accountId">;
}

/** The change's walkthrough beside a review's findings. */
function walkthroughDto(w: Row<"reviewWalkthroughs">) {
  return {
    overview: w.overview,
    groups: w.groups,
    diagram: w.diagram,
    redacted: w.redacted,
    truncated: w.truncated,
  } satisfies ReviewWalkthroughView;
}

/** In the web's lists, with the repository's short hash. */
function listedReview(r: Row<"reviews">) {
  return { ...reviewDto(r), repo: r.repoHash.slice(0, 8) };
}

/** A finding as the web's detail page shows it. */
function findingDto(f: FindingRow) {
  return {
    id: f.id,
    fingerprint: f.fingerprint,
    reviewer: f.reviewer,
    severity: f.severity,
    category: f.category,
    verification: f.verification,
    file: f.file,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    title: f.title,
    body: f.body,
    suggestion: f.suggestion,
    code: f.code,
    redacted: f.redacted,
    truncated: f.truncated,
    createdAt: f.createdAt,
    status: f.status,
    reason: f.reason,
    note: f.note,
    decidedAt: f.decidedAt,
    fixedVia: f.fixedVia,
    threadResolvedAt: f.threadResolvedAt,
    fix: fixOf(f),
  } satisfies Omit<FindingRow, "accountId" | "reviewId" | "position" | FixColumn> & {
    fix: unknown;
  };
}

type FixColumn = "fixStartLine" | "fixEndLine" | "fixReplacement";

/** The finding's fix, which the pull request page can commit; null without one. */
export function fixOf(f: Pick<FindingRow, FixColumn>) {
  if (f.fixStartLine === null || f.fixEndLine === null || f.fixReplacement === null) return null;
  return { startLine: f.fixStartLine, endLine: f.fixEndLine, replacement: f.fixReplacement };
}

export function exportFinding(f: FindingRow) {
  const fix = fixOf(f);
  return {
    fingerprint: f.fingerprint,
    reviewer: f.reviewer,
    ...(f.category !== null ? { category: f.category } : {}),
    severity: f.severity,
    ...(f.verification !== null ? { verification: f.verification } : {}),
    file: f.file,
    ...(f.lineStart !== null
      ? { lines: { start: f.lineStart, end: f.lineEnd ?? f.lineStart } }
      : {}),
    title: f.title,
    body: f.body,
    ...(f.suggestion !== null ? { suggestion: f.suggestion } : {}),
    ...(f.code !== null ? { code: f.code } : {}),
    ...(fix ? { fix } : {}),
    redacted: f.redacted,
    truncated: f.truncated,
  };
}

reviews.get("/:id/export", requireSession(), async (c) => {
  const review = await c.var.data.get("reviews", c.req.param("id"));
  if (!review) return apiError(c, "not_found");
  const [list, walkthrough] = await Promise.all([
    c.var.data.findingsOf(review.id),
    c.var.data.findOne("reviewWalkthroughs", { reviewId: review.id }),
  ]);
  c.header("content-disposition", `attachment; filename="ocra-review-${review.runId}.json"`);
  return c.json({
    format: "ocra-cloud/review-export",
    version: EXPORT_VERSION,
    review: reviewDto(review),
    findings: list.map(exportFinding),
    ...(walkthrough ? { walkthrough: walkthroughDto(walkthrough) } : {}),
  });
});

reviews.get("/", requireSession(), async (c) => {
  const days = queryDays(c, 30);
  const since = new Date(Date.now() - days * DAY);
  // The totals are summed in SQL (audit D5); the list shows the newest 500.
  const [{ summary, byReviewer }, rows, names] = await Promise.all([
    c.var.data.reviewSummary(since),
    c.var.data.listSince("reviews", since, 500),
    repoNames(c.var.data),
  ]);
  return c.json({
    days,
    summary,
    reviewers: perReviewer(byReviewer),
    reviews: rows.map((r) => ({ ...listedReview(r), name: names.get(r.repoHash) ?? null })),
  });
});

reviews.delete("/:id", requireSession(), async (c) => {
  return c.json({ removed: await c.var.data.remove("reviews", c.req.param("id")) });
});

/** What `ocra metrics` shows per reviewer, summed over the uploaded runs. */
function perReviewer(
  rows: {
    id: string;
    tasks: number;
    failedTasks: number;
    critical: number;
    warning: number;
    suggestion: number;
    costUsd: number;
    fixed: number;
    dismissed: number;
  }[],
) {
  const out: Record<
    string,
    ReviewerCounts & { findingsTotal: number; acceptanceRate: number | null }
  > = {};
  for (const { id, critical, warning, suggestion, ...r } of rows) {
    out[id] = {
      ...r,
      findings: { critical, warning, suggestion },
      findingsTotal: critical + warning + suggestion,
      acceptanceRate: r.fixed + r.dismissed > 0 ? r.fixed / (r.fixed + r.dismissed) : null,
    };
  }
  return out;
}
