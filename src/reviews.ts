import { Hono } from "hono";
import { requireSession } from "./auth.js";
import type { ReviewerCounts } from "./db/schema.js";
import { parseFindings } from "./findings.js";
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
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(id) || typeof r !== "object" || r === null) continue;
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
  // A run uploads once; a retry of the same run is not a second review.
  const existing = (await c.var.data.list("reviews")).find((r) => r.runId === row.runId);
  if (existing) return c.json({ id: existing.id, duplicate: true });
  const id = crypto.randomUUID();
  await c.var.data.insert("reviews", { id, ...row });
  // Findings are kept only while the account shares them, whatever the CLI sent.
  let stored = 0;
  let truncated = false;
  // The list goes in findingList; `findings` holds the severity counts. A list
  // under `findings` is accepted too, from a CLI built before the two split.
  const list = body?.findingList ?? (Array.isArray(body?.findings) ? body?.findings : undefined);
  if (c.var.session.account.shareFindings && list !== undefined) {
    const parsed = parseFindings(list);
    truncated = parsed.truncated;
    for (const f of parsed.rows) {
      await c.var.data.insert("findings", { id: crypto.randomUUID(), reviewId: id, ...f });
    }
    stored = parsed.rows.length;
  }
  return c.json({ id, findings: stored, ...(truncated ? { truncated: true } : {}) });
});

// One review with its findings, for the web's detail page.
reviews.get("/:id", requireSession(), async (c) => {
  const review = await c.var.data.get("reviews", c.req.param("id"));
  if (!review) return c.json({ error: "not_found" }, 404);
  const list = (await c.var.data.list("findings")).filter((f) => f.reviewId === review.id);
  const { accountId: _a, ...r } = review;
  return c.json({
    review: { ...r, repo: r.repoHash.slice(0, 8) },
    findings: list.map(({ accountId: _x, reviewId: _y, ...f }) => f),
  });
});

// ocra-cloud/review-export v1: the uploaded counts and findings in the
// report's findings[] shape. Not a report: coverage, tasks and provenance
// were never uploaded (ADR-0028, 3).
reviews.get("/:id/export", requireSession(), async (c) => {
  const review = await c.var.data.get("reviews", c.req.param("id"));
  if (!review) return c.json({ error: "not_found" }, 404);
  const list = (await c.var.data.list("findings")).filter((f) => f.reviewId === review.id);
  const { accountId: _a, ...r } = review;
  c.header("content-disposition", `attachment; filename="ocra-review-${review.runId}.json"`);
  return c.json({
    format: "ocra-cloud/review-export",
    version: 1,
    review: r,
    findings: list.map((f) => ({
      fingerprint: f.fingerprint,
      reviewer: f.reviewer,
      severity: f.severity,
      category: f.category,
      verification: f.verification,
      file: f.file,
      lines: f.lineStart === null ? null : { start: f.lineStart, end: f.lineEnd ?? f.lineStart },
      title: f.title,
      body: f.body,
      suggestion: f.suggestion,
      evidence: f.code,
      redacted: f.redacted,
      truncated: f.truncated,
    })),
  });
});

reviews.get("/", requireSession(), async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? "30") || 30, 1), 365);
  const rows = await c.var.data.listSince("reviews", new Date(Date.now() - days * DAY), 500);
  const repos = new Set(rows.map((r) => r.repoHash));
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
  return c.json({
    days,
    summary: {
      reviews: rows.length,
      repositories: repos.size,
      findings: sum((r) => r.findings),
      critical: sum((r) => r.critical),
      // significant_concerns is the verdict that blocks a merge.
      blocking: rows.filter((r) => r.verdict === "significant_concerns").length,
      incomplete: rows.filter((r) => !r.complete).length,
      fixed: sum((r) => r.fixed),
      dismissed: sum((r) => r.dismissed),
      tokensIn: sum((r) => r.tokensIn),
      tokensOut: sum((r) => r.tokensOut),
      costUsd: sum((r) => r.costUsd),
    },
    reviewers: perReviewer(rows),
    reviews: rows.map(({ accountId: _a, ...r }) => ({ ...r, repo: r.repoHash.slice(0, 8) })),
  });
});

reviews.delete("/:id", requireSession(), async (c) => {
  return c.json({ removed: await c.var.data.remove("reviews", c.req.param("id")) });
});

/** What `ocra metrics` shows per reviewer, summed over the uploaded runs. */
function perReviewer(rows: { byReviewer: Record<string, ReviewerCounts> | null }[]) {
  const out: Record<
    string,
    ReviewerCounts & { findingsTotal: number; acceptanceRate: number | null }
  > = {};
  for (const row of rows) {
    for (const [id, r] of Object.entries(row.byReviewer ?? {})) {
      const t = out[id] ?? {
        tasks: 0,
        failedTasks: 0,
        findings: { critical: 0, warning: 0, suggestion: 0 },
        costUsd: 0,
        fixed: 0,
        dismissed: 0,
        findingsTotal: 0,
        acceptanceRate: null,
      };
      t.tasks += r.tasks;
      t.failedTasks += r.failedTasks;
      t.findings.critical += r.findings.critical;
      t.findings.warning += r.findings.warning;
      t.findings.suggestion += r.findings.suggestion;
      t.findingsTotal += r.findings.critical + r.findings.warning + r.findings.suggestion;
      t.costUsd += r.costUsd;
      t.fixed += r.fixed;
      t.dismissed += r.dismissed;
      out[id] = t;
    }
  }
  for (const t of Object.values(out)) {
    t.acceptanceRate = t.fixed + t.dismissed > 0 ? t.fixed / (t.fixed + t.dismissed) : null;
  }
  return out;
}
