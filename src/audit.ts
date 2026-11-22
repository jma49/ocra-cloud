import type { Scoped } from "./db/scoped.js";
import {
  AUDIT_FIELDS,
  type AuditDetails,
  type AuditEventView,
  type AuditKind,
} from "./shared/index.js";

// The account's audit log: what changed and when, never a key or a body.

/** An audit row for a batch, written in the same transaction as its change. */
export function auditRow<K extends AuditKind>(kind: K, detail: AuditDetails[K]) {
  return { kind, detail: detail as Record<string, unknown> };
}

export async function audit<K extends AuditKind>(
  data: Scoped,
  kind: K,
  detail: AuditDetails[K],
): Promise<void> {
  await data.insert("auditEvents", auditRow(kind, detail));
}

const MAX_TEXT = 200;
const MAX_LIST = 50;
const isKind = (kind: string): kind is AuditKind => Object.hasOwn(AUDIT_FIELDS, kind);

// Only scalars and lists of short strings pass, whatever a row holds.
function safeValue(v: unknown): unknown {
  if (typeof v === "string") return v.slice(0, MAX_TEXT);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) {
    return v
      .filter((s): s is string => typeof s === "string")
      .slice(0, MAX_LIST)
      .map((s) => s.slice(0, MAX_TEXT));
  }
  return undefined;
}

type StoredEvent = {
  id: string;
  kind: string;
  detail: Record<string, unknown> | null;
  createdAt: Date;
};

/** An event as the API answers it: its kind's listed fields only; undefined for a kind it does not know. */
export function auditEventDto(row: StoredEvent): AuditEventView | undefined {
  if (!isKind(row.kind)) return undefined;
  const detail: Record<string, unknown> = {};
  for (const field of AUDIT_FIELDS[row.kind] as readonly string[]) {
    const value = safeValue(row.detail?.[field]);
    if (value !== undefined) detail[field] = value;
  }
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    detail,
  } as AuditEventView;
}
