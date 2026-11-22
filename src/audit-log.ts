import { Hono } from "hono";
import { z } from "zod";
import { auditEventDto } from "./audit.js";
import type { AuditCursor } from "./db/audit-events.js";
import { apiError, queryLimit } from "./http.js";
import { requireSession } from "./session.js";
import { AUDIT_KINDS, type AuditKind, type AuditPage } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// The account's own audit log for the console: newest first, by kind and
// time range, paged by a cursor. Each event answers only its kind's fields.

export const auditLog = new Hono<AppEnv>();

const PAGE = 50;
const millis = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform((v) => new Date(Number(v)));

const querySchema = z.object({
  kind: z.enum(AUDIT_KINDS as [AuditKind, ...AuditKind[]]).optional(),
  // Milliseconds since the epoch; since is inclusive, until exclusive.
  since: millis.optional(),
  until: millis.optional(),
  after: z
    .string()
    .regex(/^\d{1,15}_[\w-]{1,64}$/)
    .optional(),
  limit: z.string().optional(),
});

const cursorOf = (c: AuditCursor) => `${c.createdAt.getTime()}_${c.id}`;
function parseCursor(raw: string | undefined): AuditCursor | undefined {
  if (!raw) return undefined;
  const at = raw.indexOf("_");
  return { createdAt: new Date(Number(raw.slice(0, at))), id: raw.slice(at + 1) };
}

auditLog.get("/", requireSession(["web"]), async (c) => {
  const parsed = querySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return apiError(c, "invalid_body", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  const q = parsed.data;
  const { rows, next } = await c.var.data.audit.page(
    { kind: q.kind, since: q.since, until: q.until },
    queryLimit(c, PAGE),
    parseCursor(q.after),
  );
  return c.json({
    events: rows.flatMap((r) => auditEventDto(r) ?? []),
    next: next ? cursorOf(next) : null,
  } satisfies AuditPage);
});
