import {
  FINDING_RULE_ID,
  FINDING_RULE_KINDS,
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
import { ruleOf } from "./findings.js";
import { apiError, jsonBody, queryDays, queryLimit } from "./http.js";
import { perMinute } from "./rate.js";
import { repoNames } from "./repositories.js";
import { requireSession } from "./session.js";
import {
  DECISION_STATUSES,
  DISMISS_REASONS,
  FINDING_STATUSES,
  type FindingInsightRow,
  type FindingInsightsView,
  type FindingRule,
  type FindingRuleInsightRow,
  type FindingRuleKind,
  MAX_RULE_ROWS,
} from "./shared/index.js";
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
  // "<kind>:<id>", the key of a rule's insights row; "none": findings that named no rule.
  rule: z
    .union([
      z.literal("none").transform(() => null),
      z
        .string()
        .max(100)
        .transform((v) => {
          const at = v.indexOf(":");
          return { kind: v.slice(0, at), id: v.slice(at + 1) };
        })
        .pipe(
          z.object({ kind: z.enum(FINDING_RULE_KINDS), id: z.string().regex(FINDING_RULE_ID) }),
        ),
    ])
    .optional(),
  after: z
    .string()
    .regex(/^\d{1,15}_[\w-]{1,64}$/)
    .optional(),
});

const decideSchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_DECIDE),
    status: z.enum(DECISION_STATUSES),
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
        rule: q.rule,
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
      thumbsUp: f.thumbsUp,
      thumbsDown: f.thumbsDown,
      reactionsReadAt: f.reactionsReadAt,
      rule: ruleOf(f),
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

type Tally = Omit<FindingInsightRow, "key" | "acceptanceRate" | "thumbsUpRate" | "downvoteRate">;
const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);
/**
 * acceptanceRate: of the findings someone decided on, how many were fixed;
 * the 👍 and 👎 rates: of the findings whose comment people reacted to.
 */
const withRate = <T extends Tally>(t: T) => ({
  ...t,
  acceptanceRate: share(t.fixed, t.fixed + t.dismissed),
  thumbsUpRate: share(t.thumbsUp, t.reacted),
  downvoteRate: share(t.thumbsDown, t.reacted),
});
const NONE: Tally = {
  total: 0,
  open: 0,
  fixed: 0,
  dismissed: 0,
  addressed: 0,
  merged: 0,
  accepted: 0,
  thumbsUp: 0,
  thumbsDown: 0,
  reacted: 0,
};

const TALLY_KEYS = Object.keys(NONE) as (keyof Tally)[];
/** What is left of the whole once these rows are taken out, field by field. */
function rest(whole: Tally, rows: readonly Tally[]): Tally {
  const left = { ...whole };
  for (const r of rows) for (const k of TALLY_KEYS) left[k] -= r[k];
  return left;
}

type RuleTally = Tally & { kind: FindingRuleKind | null; id: string | null };
function ruleRow({ kind, id, ...t }: RuleTally): FindingRuleInsightRow {
  const rule: FindingRule = kind && id ? { kind, id } : null;
  return {
    key: rule ? `${rule.kind}:${rule.id}` : null,
    rule,
    label: rule?.id ?? null,
    ...withRate(t),
  };
}

// What the account's decisions say about its reviews: acceptance per
// reviewer, severity, category, verification and rule, and why findings were
// dismissed, and the 👍 and 👎 on ocra's comments (./finding-reactions.ts).
// Only shared findings count; the rest never reach the cloud.
inbox.get("/insights", requireSession(), async (c) => {
  const days = queryDays(c, 30);
  const i = await c.var.data.findingInsights(new Date(Date.now() - days * DAY), MAX_RULE_ROWS);
  const rows = (list: (Tally & { key: string | null })[]) => list.map(withRate);
  const others = i.rules - i.rule.length;
  return c.json({
    days,
    total: withRate(i.all ?? NONE),
    byReviewer: rows(i.reviewer),
    bySeverity: rows(i.severity),
    byCategory: rows(i.category),
    byVerification: rows(i.verification),
    byRule: i.rule.map(ruleRow),
    otherRules: others > 0 ? { ...withRate(rest(i.all ?? NONE, i.rule)), rules: others } : null,
    dismissReasons: i.reasons,
  } satisfies FindingInsightsView);
});
