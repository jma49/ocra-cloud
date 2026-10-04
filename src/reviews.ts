import { Hono } from "hono";
import type { ReviewerCounts } from "./db/schema.js";
import type { Scoped } from "./db/scoped.js";
import { parseFindings, REVIEWER_ID } from "./findings.js";
import { clampDays } from "./retention.js";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// Review metadata: the CLI uploads counts after a review, the web lists them.

export const reviews = new Hono<AppEnv>();

const DAY = 86_400_000;
const SOURCES = ["local", "github", "gitlab"] as const;
// The engine's own values (packages/core/src/domain.ts: verdictSchema,
// riskTierSchema); test/reviews.test.ts pins them.
export const VERDICTS = [
  "approved",
  "approved_with_comments",
  "minor_issues",
  "significant_concerns",
] as const;
export const TIERS = ["trivial", "lite", "full"] as const;

const count = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e12 ? v : undefined;
const pick = <T extends string>(v: unknown, allowed: readonly T[]) =>
  allowed.includes(v as T) ? (v as T) : undefined;

/** The upload, checked field by field; anything else in the body is ignored. */
export function parseUpload(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const runId = typeof b.runId === "string" && /^[\w.-]{1,64}$/.test(b.runId) ? b.runId : undefined;
  const repoHash =
    typeof b.repoHash === "string" && /^[0-9a-f]{64}$/.test(b.repoHash) ? b.repoHash : undefined;
  const source = pick(b.source, SOURCES);
  if (!runId || !repoHash || !source) return undefined;
  const f = (b.findings ?? {}) as Record<string, unknown>;
  const files = (b.files ?? {}) as Record<string, unknown>;
  const tasks = (b.tasks ?? {}) as Record<string, unknown>;
  const usage = (b.usage ?? {}) as Record<string, unknown>;
  const critical = count(f.critical) ?? 0;
  const warning = count(f.warning) ?? 0;
  const suggestion = count(f.suggestion) ?? 0;
  const cost =
    typeof usage.costUsd === "number" && usage.costUsd >= 0 && usage.costUsd < 1e6
      ? usage.costUsd
      : 0;
  const byReviewer: Record<string, ReviewerCounts> = {};
  const reviewers = (b.reviewers ?? {}) as Record<string, Record<string, unknown>>;
  if (typeof reviewers === "object" && !Array.isArray(reviewers)) {
    for (const [id, r] of Object.entries(reviewers).slice(0, 40)) {
      if (!REVIEWER_ID.test(id) || typeof r !== "object" || r === null) continue;
      const rf = (r.findings ?? {}) as Record<string, unknown>;
      byReviewer[id] = {
        tasks: count(r.tasks) ?? 0,
        failedTasks: count(r.failedTasks) ?? 0,
        findings: {
          critical: count(rf.critical) ?? 0,
          warning: count(rf.warning) ?? 0,
          suggestion: count(rf.suggestion) ?? 0,
        },
        costUsd: typeof r.costUsd === "number" && r.costUsd >= 0 && r.costUsd < 1e6 ? r.costUsd : 0,
        fixed: count(r.fixed) ?? 0,
        dismissed: count(r.dismissed) ?? 0,
      };
    }
  }
  const verification: Record<string, number> = {};
  const v = (b.verification ?? {}) as Record<string, unknown>;
  for (const key of ["confirmed", "uncertain", "unchecked"]) {
    const n = count(v[key]);
    if (n !== undefined) verification[key] = n;
  }
  const outcomes = (b.outcomes ?? {}) as Record<string, unknown>;
  return {
    byReviewer: Object.keys(byReviewer).length > 0 ? byReviewer : null,
    verification: Object.keys(verification).length > 0 ? verification : null,
    fixed: count(outcomes.fixed) ?? 0,
    dismissed: count(outcomes.dismissed) ?? 0,
    runId,
    repoHash,
    source,
    tier: pick(b.tier, TIERS) ?? null,
    verdict: pick(b.verdict, VERDICTS) ?? null,
    complete: b.complete !== false,
    findings: critical + warning + suggestion,
    critical,
    warning,
    suggestion,
    filesReviewed: count(files.reviewed) ?? 0,
    filesNotReviewed: count(files.notReviewed) ?? 0,
    tasksCompleted: count(tasks.completed) ?? 0,
    tasksFailed: count(tasks.failed) ?? 0,
    tokensIn: count(usage.inputTokens) ?? 0,
    tokensOut: count(usage.outputTokens) ?? 0,
    costUsd: cost,
    durationMs: count(b.durationMs) ?? 0,
    ocraVersion:
      typeof b.ocraVersion === "string" && /^[\w.+-]{1,32}$/.test(b.ocraVersion)
        ? b.ocraVersion
        : null,
  };
}

reviews.post("/", requireSession(["web", "cli"]), async (c) => {
  // Counts are small; findings, sent only when the account shares them, are
  // bounded to 256 KB of text (ADR-0028).
  if (Number(c.req.header("content-length") ?? "0") > 600_000)
    return c.json({ error: "body_too_large" }, 413);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const row = parseUpload(body);
  if (!row) return c.json({ error: "bad_review" }, 400);
  // Findings are kept only while the account shares them, whatever the CLI sent.
  // The list goes in findingList; `findings` holds the severity counts. A list
  // under `findings` is accepted too, from a CLI built before the two split.
  const list = body?.findingList ?? (Array.isArray(body?.findings) ? body?.findings : undefined);
  const parsed =
    c.var.session.account.shareFindings && list !== undefined
      ? parseFindings(list)
      : { rows: [], truncated: false, dropped: 0 };
  // What was left out is reported, never silently lost (audit K-models).
  const sent = body?.reviewers;
  const reviewersDropped =
    typeof sent === "object" && sent !== null && !Array.isArray(sent)
      ? Object.keys(sent).length - Object.keys(row.byReviewer ?? {}).length
      : 0;
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
