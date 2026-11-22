import { and, desc, eq } from "drizzle-orm";
import type { LiveAccess } from "../shared/index.js";
import { type Db, first } from "./client.js";
import { accounts, liveGrants, liveRuns } from "./schema.js";

// The one place a live run is read across accounts (ADR-0056): who may see
// it besides its owner. Everything after this answer reads the run through
// the owner's scoped().

export type LiveDoor = { ownerId: string; access: LiveAccess };

/**
 * How the viewer may see the run: its owner, a person it is shared with, or
 * someone signed in who has its link (linkValid checks the token against the
 * run's nonce). Undefined for anyone else, so the run stays unknown to them.
 */
export async function liveAccess(
  db: Db,
  viewerId: string,
  liveRunId: string,
  linkValid: (nonce: string) => Promise<boolean>,
): Promise<LiveDoor | undefined> {
  const run = await db
    .select({ ownerId: liveRuns.accountId, nonce: liveRuns.linkNonce, role: liveRuns.linkRole })
    .from(liveRuns)
    .where(eq(liveRuns.id, liveRunId))
    .limit(1)
    .then(first);
  if (!run) return undefined;
  if (run.ownerId === viewerId) return { ownerId: run.ownerId, access: "owner" };
  const grant = await db
    .select({ role: liveGrants.role })
    .from(liveGrants)
    .where(and(eq(liveGrants.liveRunId, liveRunId), eq(liveGrants.granteeId, viewerId)))
    .limit(1)
    .then(first);
  if (grant) return { ownerId: run.ownerId, access: grant.role };
  if (run.nonce && run.role && (await linkValid(run.nonce))) {
    return { ownerId: run.ownerId, access: run.role };
  }
  return undefined;
}

/** The runs others shared with the viewer by name, newest first. */
export function sharedWithMe(db: Db, viewerId: string, limit: number) {
  return db
    .select({ run: liveRuns, owner: accounts.login, role: liveGrants.role })
    .from(liveGrants)
    .innerJoin(liveRuns, eq(liveRuns.id, liveGrants.liveRunId))
    .innerJoin(accounts, eq(accounts.id, liveRuns.accountId))
    .where(eq(liveGrants.granteeId, viewerId))
    .orderBy(desc(liveRuns.updatedAt))
    .limit(limit);
}

/** The account a person signs in as, by their exact sign-in name; undefined when none or several. */
export async function accountByLogin(db: Db, login: string): Promise<string | undefined> {
  const found = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.login, login))
    .limit(2);
  return found.length === 1 ? found[0]?.id : undefined;
}
