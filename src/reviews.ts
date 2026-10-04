import { Hono } from "hono";
import { requireSession } from "./auth.js";
import type { ReviewerCounts } from "./db/schema.js";
import type { AppEnv } from "./types.js";

// Review metadata: the CLI uploads counts after a review, the web lists them.

export const reviews = new Hono<AppEnv>();

const DAY = 86_400_000;
const SOURCES = ["local", "github", "gitlab"] as const;
const VERDICTS = ["approved", "approved_with_comments", "changes_requested"] as const;
const TIERS = ["lite", "standard", "full"] as const;

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
  if (Number(c.req.header("content-length") ?? "0") > 16_384)
    return c.json({ error: "body_too_large" }, 413);
  const row = parseUpload(await c.req.json().catch(() => null));
  if (!row) return c.json({ error: "bad_review" }, 400);
  // A run uploads once; a retry of the same run is not a second review.
  const existing = (await c.var.data.list("reviews")).find((r) => r.runId === row.runId);
  if (existing) return c.json({ id: existing.id, duplicate: true });
  const id = crypto.randomUUID();
  await c.var.data.insert("reviews", { id, ...row });
  return c.json({ id });
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
      changesRequested: rows.filter((r) => r.verdict === "changes_requested").length,
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
