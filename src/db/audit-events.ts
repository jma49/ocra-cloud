import { and, desc, eq, gte, lt, or, type SQL } from "drizzle-orm";
import type { PageCursor } from "../page-cursor.js";
import type { AuditKind } from "../shared/index.js";
import type { Db } from "./client.js";
import { auditEvents } from "./schema.js";

// The account's audit log, newest first and paged by (created_at, id).
// Reached only through scoped().

/** Which events a page lists; a field left out matches any. `until` is exclusive. */
export type AuditFilter = {
  kind?: AuditKind | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
};

export function accountAuditEvents(db: Db, accountId: string) {
  const t = auditEvents;
  return {
    async page(filter: AuditFilter, limit: number, after?: PageCursor) {
      const conditions: (SQL | undefined)[] = [
        eq(t.accountId, accountId),
        filter.kind ? eq(t.kind, filter.kind) : undefined,
        filter.since ? gte(t.createdAt, filter.since) : undefined,
        filter.until ? lt(t.createdAt, filter.until) : undefined,
        after
          ? or(
              lt(t.createdAt, after.createdAt),
              and(eq(t.createdAt, after.createdAt), lt(t.id, after.id)),
            )
          : undefined,
      ];
      const rows = await db
        .select({ id: t.id, kind: t.kind, detail: t.detail, createdAt: t.createdAt })
        .from(t)
        .where(and(...conditions))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit);
      const last = rows.at(-1);
      const next =
        rows.length === limit && last ? { createdAt: last.createdAt, id: last.id } : null;
      return { rows, next };
    },
  };
}
