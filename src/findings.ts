import { redact } from "./redact.js";

// A finding as the CLI uploads it when the account shares findings
// (ADR-0028, 2), checked, redacted and bounded again on the server.

export const MAX_FINDINGS = 200;
const MAX_FIELD = 4096;
const MAX_TOTAL = 262_144;
const SEVERITIES = ["critical", "warning", "suggestion"];
const VERIFICATIONS = ["confirmed", "uncertain", "unchecked"];

export type FindingRow = {
  fingerprint: string;
  reviewer: string;
  severity: string;
  category: string | null;
  verification: string | null;
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

const line = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 10_000_000 ? v : null;

export function parseFindings(list: unknown): { rows: FindingRow[]; truncated: boolean } {
  if (!Array.isArray(list)) return { rows: [], truncated: false };
  let total = 0;
  let truncated = list.length > MAX_FINDINGS;
  const rows: FindingRow[] = [];
  for (const raw of list.slice(0, MAX_FINDINGS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const f = raw as Record<string, unknown>;
    if (typeof f.fingerprint !== "string" || !/^[\w:.-]{4,128}$/.test(f.fingerprint)) continue;
    if (typeof f.reviewer !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(f.reviewer)) continue;
    if (!SEVERITIES.includes(f.severity as string)) continue;
    if (typeof f.file !== "string" || f.file.length === 0 || f.file.length > 1024) continue;
    if (typeof f.title !== "string" || typeof f.body !== "string") continue;
    let rowRedacted = false;
    let rowTruncated = false;
    const text = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      const r = redact(v);
      rowRedacted ||= r.redacted;
      if (r.text.length > MAX_FIELD) {
        rowTruncated = true;
        return r.text.slice(0, MAX_FIELD);
      }
      return r.text;
    };
    const row: FindingRow = {
      fingerprint: f.fingerprint,
      reviewer: f.reviewer,
      severity: f.severity as string,
      category: typeof f.category === "string" ? (text(f.category.slice(0, 64)) ?? null) : null,
      verification: VERIFICATIONS.includes(f.verification as string)
        ? (f.verification as string)
        : null,
      file: text(f.file) ?? "",
      lineStart: line(f.lineStart),
      lineEnd: line(f.lineEnd),
      title: text(f.title) ?? "",
      body: text(f.body) ?? "",
      suggestion: text(f.suggestion),
      code: text(f.code),
      redacted: false,
      truncated: false,
    };
    row.redacted = rowRedacted || f.redacted === true;
    row.truncated = rowTruncated || f.truncated === true;
    const size =
      row.title.length + row.body.length + (row.suggestion?.length ?? 0) + (row.code?.length ?? 0);
    if (total + size > MAX_TOTAL) {
      truncated = true;
      break;
    }
    total += size;
    rows.push(row);
  }
  return { rows, truncated };
}
