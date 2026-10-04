import { Hono } from "hono";
import { clearSessionCookie, requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// The account's signed-in browsers and terminals, and signing one out.

export const sessions = new Hono<AppEnv>().use(requireSession());

sessions.get("/", async (c) => {
  const rows = await c.var.data.liveSessions(new Date());
  return c.json({
    sessions: rows.map((s) => ({
      id: s.id,
      kind: s.kind,
      label: s.label,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.refreshExpiresAt ?? s.expiresAt,
      current: s.id === c.var.session.sessionId,
    })),
  });
});

sessions.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const removed = await c.var.data.remove("sessions", id);
  if (removed && id === c.var.session.sessionId) clearSessionCookie(c);
  return c.json({ removed });
});
