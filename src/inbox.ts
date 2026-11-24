import {
  MAX_FIELD,
  MAX_MEMORY_PER_REPO,
  REPO_HASH,
  REVIEWER_ID,
  redactField,
  SEVERITIES,
  VERIFICATIONS,
} from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import { z } from "zod";
import type { Decision, InboxCursor } from "./db/inbox.js";
import { apiError, jsonBody, queryDays, queryLimit } from "./http.js";
import { perMinute } from "./rate.js";
import { repoNames } from "./repositories.js";
import { requireSession } from "./session.js";
import { DISMISS_REASONS, FINDING_STATUSES } from "./shared/index.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";

// The findings inbox: every shared finding of the account across its
// reviews, filtered and paged, and what the account decided about each one
// (fixed, dismissed with a reason, or open again). A dismissal can also
// remember the finding (ADR-0028, 4), so the repository's next signed-in
// review stops reporting it.

export const inbox = new Hono<AppEnv>();

const PAGE = 50;
/** How many findings one decision may name. */
const MAX_DECIDE = 100;

const filterSchema = z.object({
  status: z.enum(FINDING_STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  // "none": findings the verifier never looked at.
  verification: z.enum([...VERIFICATIONS, "none"]).optional(),
  reviewer: z.string().regex(REVIEWER_ID).optional(),
  repo: z.string().regex(REPO_HASH).optional(),
  after: z
    .string()
    .regex(/^\d{1,15}_[\w-]{1,64}$/)
    .optional(),
});

const decideSchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_DECIDE),
    status: z.enum(FINDING_STATUSES),
    reason: z.enum(DISMISS_REASONS).optional(),
    note: z.string().max(MAX_FIELD).optional(),
    // Dismissed findings only: also remember each one for its repository.
    remember: z.boolean().optional(),
  })
  .refine((d) => (d.status === "dismissed") === (d.reason !== undefined), {
    message: "a dismissal names a reason, and only a dismissal does",
    path: ["reason"],
  })
  .refine((d) => d.remember !== true || d.status === "dismissed", {
    message: "only a dismissed finding is remembered",
    path: ["remember"],
  });

const cursorOf = (c: InboxCursor) => `${c.createdAt.getTime()}_${c.id}`;
function parseCursor(raw: string | undefined): InboxCursor | undefined {
  if (!raw) return undefined;
  const at = raw.indexOf("_");
  return { createdAt: new Date(Number(raw.slice(0, at))), id: raw.slice(at + 1) };
}

inbox.get("/", requireSession(), async (c) => {
  const parsed = filterSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return apiError(c, "invalid_body", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  const q = parsed.data;
  const [{ rows, next }, counts, names] = await Promise.all([
    c.var.data.inbox(
      {
        status: q.status,
        severity: q.severity,
        verification: q.verification === "none" ? null : q.verification,
        reviewer: q.reviewer,
        repoHash: q.repo,
      },
      queryLimit(c, PAGE),
      parseCursor(q.after),
    ),
    c.var.data.findingStatusCounts(),
    repoNames(c.var.data),
  ]);
  const statuses = Object.fromEntries(FINDING_STATUSES.map((s) => [s, 0]));
  for (const { status, n } of counts) statuses[status] = n;
  return c.json({
    findings: rows.map(({ finding: f, repoHash, runId, prNumber }) => ({
      id: f.id,
      reviewId: f.reviewId,
      runId,
      repoHash,
      repo: repoHash.slice(0, 8),
      name: names.get(repoHash) ?? null,
      prNumber,
      fingerprint: f.fingerprint,
      reviewer: f.reviewer,
      severity: f.severity,
      category: f.category,
      verification: f.verification,
      file: f.file,
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
      title: f.title,
      status: f.status,
      reason: f.reason,
      note: f.note,
      decidedAt: f.decidedAt,
      createdAt: f.createdAt,
    })),
    next: next ? cursorOf(next) : null,
    statuses,
  });
});

inbox.post(
  "/decide",
  requireSession(),
  perMinute("settings"),
  jsonBody(decideSchema),
  async (c) => {
    const d = c.req.valid("json");
    const decision: Decision =
      d.status === "open"
        ? { status: "open", reason: null, note: null, decidedAt: null }
        : {
            status: d.status,
            reason: d.reason ?? null,
            note: d.note ? redactField(d.note).text : null,
            decidedAt: new Date(),
          };
    const ids = [...new Set(d.ids)];
    const changed = await c.var.data.decide(ids, decision);
    if (changed === 0) return apiError(c, "not_found");
    const memory = d.remember
      ? await c.var.data.rememberFindings(
          ids,
          decision.note ? `${d.reason}: ${decision.note}` : (d.reason ?? ""),
          MAX_MEMORY_PER_REPO,
        )
      : { added: 0, full: false };
    return c.json({
      changed,
      remembered: memory.added,
      ...(memory.full ? { memoryFull: true } : {}),
    });
  },
);

type Tally = { total: number; open: number; fixed: number; dismissed: number };
/** fixed / (fixed + dismissed): of the findings someone decided on, how many were right; null before any. */
const withRate = <T extends Tally>(t: T) => ({
  ...t,
  acceptanceRate: t.fixed + t.dismissed > 0 ? t.fixed / (t.fixed + t.dismissed) : null,
});

// What the account's decisions say about its reviews: acceptance per
// reviewer, severity, category and verification, and why findings were
// dismissed. Only shared findings count; the rest never reach the cloud.
inbox.get("/insights", requireSession(), async (c) => {
  const days = queryDays(c, 30);
  const i = await c.var.data.findingInsights(new Date(Date.now() - days * DAY));
  const rows = (list: (Tally & { key: string | null })[]) => list.map(withRate);
  return c.json({
    days,
    total: withRate(i.all ?? { total: 0, open: 0, fixed: 0, dismissed: 0 }),
    byReviewer: rows(i.reviewer),
    bySeverity: rows(i.severity),
    byCategory: rows(i.category),
    byVerification: rows(i.verification),
    dismissReasons: i.reasons,
  });
});
