import { Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { accountSalt, deleteAccount, setSharing } from "./db/accounts.js";
import { apiError, jsonBody } from "./http.js";
import { perMinute } from "./rate.js";
import { clearSessionCookie, requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// The account itself: deleting it, and sharing findings. Its routes differ
// in which sessions reach them (the CLI reads the salt), so each carries its
// own guard.

export const account = new Hono<AppEnv>();

// The account's login, typed again; anything else is refused as unconfirmed.
const deleteRequest = z.object({ confirm: z.unknown() });

account.delete("/", requireSession(), jsonBody(deleteRequest), async (c) => {
  if (c.req.valid("json").confirm !== c.var.session.account.login) {
    return apiError(c, "confirm_with_login");
  }
  await deleteAccount(c.var.db, c.var.session.account.id);
  clearSessionCookie(c);
  return c.json({ deleted: true });
});

// Sharing findings (ADR-0028, 2): off by default. Turning it off can delete
// every finding sent; the counts stay. The allowance is the findings that
// may be sent in the retention window, deleted ones included (audit C1).
account.get("/sharing", requireSession(), async (c) => {
  const stored = await c.var.data.count("findings");
  return c.json({
    shareFindings: c.var.session.account.shareFindings,
    findingsStored: stored,
    findingsAllowance: config(c.env).reviewMaxFindings,
  });
});

const sharingRequest = z.object({
  enabled: z.boolean(),
  deleteExisting: z.boolean().optional(),
});

account.put(
  "/sharing",
  requireSession(),
  perMinute("settings"),
  jsonBody(sharingRequest),
  async (c) => {
    const body = c.req.valid("json");
    await setSharing(c.var.db, c.var.session.account.id, body.enabled);
    const deleted =
      !body.enabled && body.deleteExisting === true
        ? await c.var.data.removeWhere("findings", {})
        : 0;
    await audit(c.var.data, "sharing.changed", { shareFindings: body.enabled, deleted });
    return c.json({ shareFindings: body.enabled, deleted });
  },
);

// The account's repository-hash salt, so one repository hashes alike on all
// its machines; only while findings are shared (ADR-0028, 4).
account.get("/salt", requireSession(["web", "cli"]), async (c) => {
  if (!c.var.session.account.shareFindings) return c.json({ salt: null });
  return c.json({ salt: await accountSalt(c.var.db, c.var.session.account.id) });
});
