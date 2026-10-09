import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { accounts, sessions } from "./schema.js";

// The queries that cannot be scoped by an account, because they find it:
// signing in by GitHub id, and resolving a session token.

export type Account = typeof accounts.$inferSelect;

/** The account of a GitHub user, created on first sign-in; the login is kept current. */
export async function upsertAccount(
  db: DrizzleD1Database,
  githubId: number,
  login: string,
): Promise<Account> {
  const [row] = await db
    .insert(accounts)
    .values({ id: crypto.randomUUID(), githubId, login })
    .onConflictDoUpdate({ target: accounts.githubId, set: { login } })
    .returning();
  if (!row) throw new Error("account upsert returned no row");
  return row;
}

export type SessionAccount = {
  account: Account;
  sessionId: string;
  kind: "web" | "cli";
  /** When the session's sign-in happened. */
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
};

/** The live session with this token hash, and its account. */
export async function sessionByTokenHash(
  db: DrizzleD1Database,
  tokenHash: string,
  now = new Date(),
): Promise<SessionAccount | undefined> {
  const row = await db
    .select({
      account: accounts,
      sessionId: sessions.id,
      kind: sessions.kind,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      lastUsedAt: sessions.lastUsedAt,
    })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(
      or(
        and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)),
        // The access token before the last refresh, until its own expiry.
        and(eq(sessions.prevTokenHash, tokenHash), gt(sessions.prevExpiresAt, now)),
      ),
    )
    .get();
  return row;
}

export type RefreshSession = {
  sessionId: string;
  accountId: string;
  tokenHash: string;
  expiresAt: Date;
  refreshHash: string | null;
  refreshExpiresAt: Date | null;
  prevRefreshHash: string | null;
  rotatedAt: Date | null;
};

/**
 * The CLI session whose current or previous refresh token has this hash,
 * while the session lasts. The caller tells the two apart by refreshHash.
 */
export async function sessionByRefreshHash(
  db: DrizzleD1Database,
  refreshHash: string,
  now = new Date(),
): Promise<RefreshSession | undefined> {
  return db
    .select({
      sessionId: sessions.id,
      accountId: sessions.accountId,
      tokenHash: sessions.tokenHash,
      expiresAt: sessions.expiresAt,
      refreshHash: sessions.refreshHash,
      refreshExpiresAt: sessions.refreshExpiresAt,
      prevRefreshHash: sessions.prevRefreshHash,
      rotatedAt: sessions.rotatedAt,
    })
    .from(sessions)
    .where(
      and(
        or(eq(sessions.refreshHash, refreshHash), eq(sessions.prevRefreshHash, refreshHash)),
        gt(sessions.refreshExpiresAt, now),
      ),
    )
    .get();
}

/**
 * Replaces a CLI session's tokens only while its refresh token is still
 * `currentRefreshHash`: of two refreshes racing with the same token, one wins.
 */
export async function rotateSession(
  db: DrizzleD1Database,
  sessionId: string,
  currentRefreshHash: string,
  changes: Partial<typeof sessions.$inferInsert>,
): Promise<boolean> {
  const result = await db
    .update(sessions)
    .set(changes)
    .where(and(eq(sessions.id, sessionId), eq(sessions.refreshHash, currentRefreshHash)))
    .run();
  return result.meta.changes > 0;
}

/** Ends a session, as when a refresh token is used again after its rotation. */
export async function revokeSession(db: DrizzleD1Database, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Deletes an account; its sessions, keys and records go with it (cascade). */
export async function deleteAccount(db: DrizzleD1Database, accountId: string): Promise<void> {
  await db.delete(accounts).where(eq(accounts.id, accountId));
}

export async function setSharing(
  db: DrizzleD1Database,
  accountId: string,
  on: boolean,
): Promise<void> {
  await db.update(accounts).set({ shareFindings: on }).where(eq(accounts.id, accountId));
}

/** The account's salt, made on first use (64 hex characters). */
export async function accountSalt(db: DrizzleD1Database, accountId: string): Promise<string> {
  const row = await db
    .select({ salt: accounts.salt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (row?.salt) return row.salt;
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  // Only the first writer's salt stands, so two machines cannot race to different ones.
  await db
    .update(accounts)
    .set({ salt })
    .where(and(eq(accounts.id, accountId), isNull(accounts.salt)));
  const after = await db
    .select({ salt: accounts.salt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  return after?.salt ?? salt;
}
