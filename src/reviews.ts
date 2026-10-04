import { Hono } from "hono";
import { requireSession } from "./auth.js";
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
  return {
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
      tokensIn: sum((r) => r.tokensIn),
      tokensOut: sum((r) => r.tokensOut),
      costUsd: sum((r) => r.costUsd),
    },
    reviews: rows.map(({ accountId: _a, ...r }) => ({ ...r, repo: r.repoHash.slice(0, 8) })),
  });
});

reviews.delete("/:id", requireSession(), async (c) => {
  return c.json({ removed: await c.var.data.remove("reviews", c.req.param("id")) });
});
