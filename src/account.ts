import { Hono } from "hono";
import { audit } from "./audit.js";
import { accountSalt, deleteAccount, setSharing } from "./db/accounts.js";
import { clearSessionCookie, requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// The account itself: deleting it, and sharing findings. Its routes differ
// in which sessions reach them (the CLI reads the salt), so each carries its
// own guard.

export const account = new Hono<AppEnv>();

account.delete("/", requireSession(), async (c) => {
  const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== c.var.session.account.login) {
    return c.json({ error: "confirm_with_login" }, 400);
  }
  await deleteAccount(c.var.db, c.var.session.account.id);
  clearSessionCookie(c);
  return c.json({ deleted: true });
});

// Sharing findings (ADR-0028, 2): off by default. Turning it off can delete
// every finding sent; the counts stay.
account.get("/sharing", requireSession(), async (c) => {
  const stored = await c.var.data.countAll("findings");
  return c.json({ shareFindings: c.var.session.account.shareFindings, findingsStored: stored });
});

account.put("/sharing", requireSession(), async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    enabled?: unknown;
    deleteExisting?: unknown;
  } | null;
  if (typeof body?.enabled !== "boolean") return c.json({ error: "bad_request" }, 400);
  await setSharing(c.var.db, c.var.session.account.id, body.enabled);
  const deleted =
    !body.enabled && body.deleteExisting === true ? await c.var.data.removeAll("findings") : 0;
  await audit(c.var.data, "sharing.changed", { shareFindings: body.enabled, deleted });
  return c.json({ shareFindings: body.enabled, deleted });
});

// The account's repository-hash salt, so one repository hashes alike on all
// its machines; only while findings are shared (ADR-0028, 4).
account.get("/salt", requireSession(["web", "cli"]), async (c) => {
  if (!c.var.session.account.shareFindings) return c.json({ salt: null });
  return c.json({ salt: await accountSalt(c.var.db, c.var.session.account.id) });
});
