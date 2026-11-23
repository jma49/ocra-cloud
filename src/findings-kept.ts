import type { Context } from "hono";
import { keepsStored } from "./db/accounts.js";
import type { AppEnv } from "./types.js";

// Whose findings the server keeps and shows (ADR-0028, 2). An account that
// shares findings keeps every review's. One that does not still keeps those
// of the reviews this server runs for it, unless it switched that off: the
// server read that code to review it, so nothing more leaves the user's
// hands. A CLI on the user's own machine sends findings only when shared.

/** Whether this session's findings are kept and shown: a CLI session's only when it is a hosted run's. */
export async function keepsFindings(c: Context<AppEnv>): Promise<boolean> {
  const { account, kind, sessionId } = c.var.session;
  if (account.shareFindings || !keepsStored(account)) return account.shareFindings;
  return kind !== "cli" || (await c.var.data.autoReview.isJob(sessionId));
}
