import { Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { accountSalt, deleteAccount, setHostedFindings, setSharing } from "./db/accounts.js";
import type { Scoped } from "./db/scoped.js";
import { keepsFindings } from "./findings-kept.js";
import { apiError, jsonBody } from "./http.js";
import { perMinute } from "./rate.js";
import { clearSessionCookie, needsRecentSignIn, requireSession } from "./session.js";
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
  const refused = needsRecentSignIn(c);
  if (refused) return refused;
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
    // On until switched off: the first review this server runs for the account starts it.
    hostedFindings: c.var.session.account.hostedFindings !== false,
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
    const deletes = !body.enabled && body.deleteExisting === true;
    const refused = deletes ? needsRecentSignIn(c) : undefined;
    if (refused) return refused;
    await setSharing(c.var.db, c.var.session.account.id, body.enabled);
    const deleted = deletes ? await deleteFindings(c.var.data) : 0;
    await audit(c.var.data, "sharing.changed", { shareFindings: body.enabled, deleted });
    return c.json({ shareFindings: body.enabled, deleted });
  },
);

// Findings of the reviews this server runs: kept from the account's first
// such review until switched off here, whether or not the CLI's are shared.
account.put(
  "/sharing/hosted",
  requireSession(),
  perMinute("settings"),
  jsonBody(sharingRequest),
  async (c) => {
    const body = c.req.valid("json");
    const deletes =
      !body.enabled && body.deleteExisting === true && !c.var.session.account.shareFindings;
    const refused = deletes ? needsRecentSignIn(c) : undefined;
    if (refused) return refused;
    await setHostedFindings(c.var.db, c.var.session.account.id, body.enabled);
    const deleted = deletes ? await deleteFindings(c.var.data) : 0;
    await audit(c.var.data, "sharing.hosted_changed", { hostedFindings: body.enabled, deleted });
    return c.json({ hostedFindings: body.enabled, deleted });
  },
);

/**
 * Deletes every finding the account stored. Walkthroughs are kept with the
 * findings and go with them, and so do the "Ask ocra" conversations, whose
 * answers quote them.
 */
async function deleteFindings(data: Scoped): Promise<number> {
  const deleted = await data.removeWhere("findings", {});
  await data.removeWhere("reviewWalkthroughs", {});
  await data.removeWhere("reviewChatMessages", {});
  return deleted;
}

// The account's repository-hash salt, so one repository hashes alike on all
// its machines; only for a session whose findings are kept (ADR-0028, 4).
account.get("/salt", requireSession(["web", "cli"]), async (c) => {
  if (!(await keepsFindings(c))) return c.json({ salt: null });
  return c.json({ salt: await accountSalt(c.var.db, c.var.session.account.id) });
});
