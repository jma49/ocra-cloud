import { Hono } from "hono";
import { audit } from "./audit.js";
import { clearSessionCookie, requireSession, webSessionEnd } from "./session.js";
import type { AppEnv } from "./types.js";

// The account's signed-in browsers and terminals, and signing one out.

export const sessions = new Hono<AppEnv>().use(requireSession());

sessions.get("/", async (c) => {
  const now = new Date();
  const rows = await c.var.data.liveSessions(now);
  // A browser session unused too long has ended though its row is kept.
  const live = rows.filter((s) => s.kind === "cli" || webSessionEnd(s) > now);
  return c.json({
    sessions: live.map((s) => ({
      id: s.id,
      kind: s.kind,
      label: s.label,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.kind === "web" ? webSessionEnd(s) : (s.refreshExpiresAt ?? s.expiresAt),
      current: s.id === c.var.session.sessionId,
    })),
  });
});

sessions.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const removed = await c.var.data.remove("sessions", id);
  const current = id === c.var.session.sessionId;
  if (removed) await audit(c.var.data, "session.revoked", { current });
  if (removed && current) clearSessionCookie(c);
  return c.json({ removed });
});
