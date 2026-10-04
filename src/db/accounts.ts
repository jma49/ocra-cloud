import { and, eq, gt } from "drizzle-orm";
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
      lastUsedAt: sessions.lastUsedAt,
    })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .get();
  return row;
}

/** The CLI session whose refresh token has this hash, while it is valid. */
export async function sessionByRefreshHash(
  db: DrizzleD1Database,
  refreshHash: string,
  now = new Date(),
): Promise<{ sessionId: string; accountId: string } | undefined> {
  return db
    .select({ sessionId: sessions.id, accountId: sessions.accountId })
    .from(sessions)
    .where(and(eq(sessions.refreshHash, refreshHash), gt(sessions.refreshExpiresAt, now)))
    .get();
}

/** Deletes an account; its sessions, keys and records go with it (cascade). */
export async function deleteAccount(db: DrizzleD1Database, accountId: string): Promise<void> {
  await db.delete(accounts).where(eq(accounts.id, accountId));
}
