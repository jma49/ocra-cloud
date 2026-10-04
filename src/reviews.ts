import { Hono } from "hono";
import { readJson } from "./body.js";
import { MAX_REVIEWERS, REVIEWER_ID, reviewUploadSchema } from "./contract/index.js";
import { clampDays } from "./db/retention.js";
import type { ReviewerCounts } from "./db/schema.js";
import type { Scoped } from "./db/scoped.js";
import { parseFindings } from "./findings.js";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// Review metadata: the CLI uploads counts after a review, the web lists them.

export const reviews = new Hono<AppEnv>();

const DAY = 86_400_000;
/** An upload's largest body, in bytes. */
const MAX_UPLOAD = 600_000;
// The CLI's findings go in findingList, read on their own by parseFindings.
const countsSchema = reviewUploadSchema.omit({ findingList: true });

/** The upload's counts, checked with the contract's schema; undefined when it is not one. */
export function parseUpload(body: unknown) {
  const parsed = countsSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const u = parsed.data;
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

reviews.post("/", requireSession(["web", "cli"]), async (c) => {
  // Counts are small; findings, sent only when the account shares them, are
  // bounded to 256 KB of text (ADR-0028). Past MAX_UPLOAD bytes: 413.
  const body = (await readJson(c, MAX_UPLOAD)) as Record<string, unknown> | null;
  const upload = parseUpload(body);
  if (!upload) return c.json({ error: "bad_review" }, 400);
  const { reviewersDropped, ...row } = upload;
  // Findings are kept only while the account shares them, whatever the CLI sent.
  const list = body?.findingList;
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
    { id: crypto.randomUUID(), ...row },
    parsed.rows,
    {
      since: new Date(new Date().toISOString().slice(0, 10)),
      dailyUploads: limit,
      maxFindings: Number(c.env.REVIEW_MAX_FINDINGS),
    },
  );
  if (duplicate) return c.json({ id, duplicate: true });
  if (limited) return c.json({ error: "daily_limit", limit }, 429);
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
  if (!review) return c.json({ error: "not_found" }, 404);
  const list = await c.var.data.findingsOf(review.id);
  const { accountId: _a, ...r } = review;
  return c.json({
    review: { ...r, repo: r.repoHash.slice(0, 8) },
    findings: list.map(({ accountId: _x, reviewId: _y, ...f }) => f),
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
// evidence, fix and provenance were never uploaded, so they are absent.
// Two fields are ocra Cloud's own: `redacted` (the server or the CLI
// replaced a secret-looking string with [redacted]) and `truncated` (a
// long field was cut).
export const EXPORT_VERSION = 2;

type FindingRow = Awaited<ReturnType<Scoped["findingsOf"]>>[number];

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
  if (!review) return c.json({ error: "not_found" }, 404);
  const list = await c.var.data.findingsOf(review.id);
  const { accountId: _a, ...r } = review;
  c.header("content-disposition", `attachment; filename="ocra-review-${review.runId}.json"`);
  return c.json({
    format: "ocra-cloud/review-export",
    version: EXPORT_VERSION,
    review: r,
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
    reviews: rows.map(({ accountId: _a, ...r }) => ({ ...r, repo: r.repoHash.slice(0, 8) })),
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
