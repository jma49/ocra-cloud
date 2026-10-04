import { Hono } from "hono";
import type { z } from "zod";
import { MAX_REVIEWERS, REVIEWER_ID, reviewUploadSchema } from "./contract/index.js";
import { clampDays } from "./db/retention.js";
import type { ReviewerCounts } from "./db/schema.js";
import type { Row, Scoped } from "./db/scoped.js";
import { parseFindings } from "./findings.js";
import { apiError, jsonBody } from "./http.js";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// Review metadata: the CLI uploads counts after a review, the web lists them.

export const reviews = new Hono<AppEnv>();

const DAY = 86_400_000;
/** An upload's largest body, in bytes. */
const MAX_UPLOAD = 600_000;
type Upload = z.output<typeof reviewUploadSchema>;

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
    // How many reviewers' counts were left out, for the answer's `dropped`.
    reviewersDropped: Object.keys(u.reviewers ?? {}).length - Object.keys(byReviewer).length,
  };
}

// Counts are small; findings, sent only when the account shares them, are
// bounded to 256 KB of text (ADR-0028). Past MAX_UPLOAD bytes: 413.
const uploadBody = jsonBody(reviewUploadSchema, { max: MAX_UPLOAD });

reviews.post("/", requireSession(["web", "cli"]), uploadBody, async (c) => {
  const upload = c.req.valid("json");
  const { reviewersDropped, ...row } = reviewRow(upload);
  // Findings are kept only while the account shares them, whatever the CLI sent.
  const list = upload.findingList;
  const parsed =
    c.var.session.account.shareFindings && list !== undefined
      ? parseFindings(list)
      : { rows: [], truncated: false, dropped: 0 };
  // What was left out is reported, never silently lost (audit K-models).
  const dropped = {
    ...(parsed.dropped > 0 ? { findings: parsed.dropped } : {}),
    ...(reviewersDropped > 0 ? { reviewers: reviewersDropped } : {}),
  };
  // A run uploads once; a retry of the same run, even a concurrent one, is
  // not a second review. Uploads per UTC day and stored findings are capped
  // per account (audit S3): a loop of uploads cannot fill the database.
  const limit = Number(c.env.REVIEW_DAILY_UPLOADS);
  const { id, duplicate, limited, findingsSkipped } = await c.var.data.insertReview(
    row,
    parsed.rows,
    {
      since: new Date(new Date().toISOString().slice(0, 10)),
      dailyUploads: limit,
      maxFindings: Number(c.env.REVIEW_MAX_FINDINGS),
    },
  );
  if (duplicate) return c.json({ id, duplicate: true });
  if (limited) return apiError(c, "daily_limit", { limit });
  return c.json({
    id,
    findings: findingsSkipped ? 0 : parsed.rows.length,
    ...(parsed.truncated ? { truncated: true } : {}),
    ...(Object.keys(dropped).length > 0 ? { dropped } : {}),
    ...(findingsSkipped ? { findingsSkipped: "account_limit" } : {}),
  });
});

// One review with its findings, for the web's detail page.
reviews.get("/:id", requireSession(), async (c) => {
  const review = await c.var.data.get("reviews", c.req.param("id"));
  if (!review) return apiError(c, "not_found");
  const list = await c.var.data.findingsOf(review.id);
  return c.json({ review: listedReview(review), findings: list.map(findingDto) });
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
// evidence, fix and provenance were never uploaded, so they are absent.
// Two fields are ocra Cloud's own: `redacted` (the server or the CLI
// replaced a secret-looking string with [redacted]) and `truncated` (a
// long field was cut).
export const EXPORT_VERSION = 2;

type FindingRow = Awaited<ReturnType<Scoped["findingsOf"]>>[number];

/** A review as the web and the export show it; the account id stays on the server. */
export function reviewDto(r: Row<"reviews">) {
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
    byReviewer: r.byReviewer,
    verification: r.verification,
    fixed: r.fixed,
    dismissed: r.dismissed,
    createdAt: r.createdAt,
  } satisfies Omit<Row<"reviews">, "accountId">;
}

/** In the web's lists, with the repository's short hash. */
function listedReview(r: Row<"reviews">) {
  return { ...reviewDto(r), repo: r.repoHash.slice(0, 8) };
}

/** A finding as the web's detail page shows it. */
export function findingDto(f: FindingRow) {
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
  } satisfies Omit<FindingRow, "accountId" | "reviewId">;
}

export function exportFinding(f: FindingRow) {
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
    redacted: f.redacted,
    truncated: f.truncated,
  };
}

reviews.get("/:id/export", requireSession(), async (c) => {
  const review = await c.var.data.get("reviews", c.req.param("id"));
  if (!review) return apiError(c, "not_found");
  const list = await c.var.data.findingsOf(review.id);
  c.header("content-disposition", `attachment; filename="ocra-review-${review.runId}.json"`);
  return c.json({
    format: "ocra-cloud/review-export",
    version: EXPORT_VERSION,
    review: reviewDto(review),
    findings: list.map(exportFinding),
  });
});

reviews.get("/", requireSession(), async (c) => {
  const days = clampDays(c.req.query("days"), 30);
  const since = new Date(Date.now() - days * DAY);
  // The totals are summed in SQL (audit D5); the list shows the newest 500.
  const [{ summary, byReviewer }, rows] = await Promise.all([
    c.var.data.reviewSummary(since),
    c.var.data.listSince("reviews", since, 500),
  ]);
  return c.json({
    days,
    summary,
    reviewers: perReviewer(byReviewer),
    reviews: rows.map(listedReview),
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
