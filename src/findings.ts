import {
  MAX_FINDINGS,
  MAX_TOTAL_BYTES,
  redactField,
  sharedFindingSchema,
} from "@open-cr-agent/cloud-contract";
import type { Severity, Verification } from "./shared/index.js";

// A finding as the CLI uploads it when the account shares findings
// (ADR-0028, 2), checked with the contract's schema, then bounded and
// redacted again on the server: a client that skipped its own pass, or a
// hostile one, gets no more stored. Each field is cut before it is redacted
// (redactField), so the work per field is bounded by the cap.

export type FindingRow = {
  fingerprint: string;
  reviewer: string;
  severity: Severity;
  category: string | null;
  verification: Verification | null;
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  title: string;
  body: string;
  suggestion: string | null;
  code: string | null;
  redacted: boolean;
  truncated: boolean;
};

const MAX_CATEGORY = 64;

/** dropped: findings left out because a field was missing or malformed. */
export function parseFindings(list: unknown): {
  rows: FindingRow[];
  truncated: boolean;
  dropped: number;
} {
  if (!Array.isArray(list)) return { rows: [], truncated: false, dropped: 0 };
  let dropped = 0;
  let total = 0;
  let truncated = list.length > MAX_FINDINGS;
  const rows: FindingRow[] = [];
  for (const raw of list.slice(0, MAX_FINDINGS)) {
    const parsed = sharedFindingSchema.safeParse(raw);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    const f = parsed.data;
    let rowRedacted = false;
    let rowTruncated = false;
    const text = (v: string, max?: number): string => {
      const r = redactField(v, max);
      rowRedacted ||= r.redacted;
      rowTruncated ||= r.truncated;
      return r.text;
    };
    const row: FindingRow = {
      fingerprint: f.fingerprint,
      reviewer: f.reviewer,
      severity: f.severity,
      category: f.category === null ? null : text(f.category, MAX_CATEGORY),
      verification: f.verification,
      file: text(f.file),
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
      title: text(f.title),
      body: text(f.body),
      suggestion: f.suggestion === null ? null : text(f.suggestion),
      code: f.code === null ? null : text(f.code),
      redacted: false,
      truncated: false,
    };
    row.redacted = rowRedacted || f.redacted === true;
    row.truncated = rowTruncated || f.truncated === true;
    const size =
      row.title.length + row.body.length + (row.suggestion?.length ?? 0) + (row.code?.length ?? 0);
    if (total + size > MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    total += size;
    rows.push(row);
  }
  return { rows, truncated, dropped };
}
