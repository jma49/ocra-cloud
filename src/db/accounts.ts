import { and, eq, gt, isNull, or } from "drizzle-orm";
import { changedRows, type Db, first } from "./client.js";
import { accounts, identities, sessions } from "./schema.js";

// The queries that cannot be scoped by an account, because they find it:
// signing in by a provider's identity, and resolving a session token.

export type Account = typeof accounts.$inferSelect;
export type Identity = Pick<typeof identities.$inferSelect, "provider" | "subject">;

export const githubIdentity = (githubId: number): Identity => ({
  provider: "github",
  subject: String(githubId),
});

async function accountOf(db: Db, identity: Identity): Promise<Account | undefined> {
  const row = await db
    .select({ account: accounts })
    .from(identities)
    .innerJoin(accounts, eq(accounts.id, identities.accountId))
    .where(
      and(eq(identities.provider, identity.provider), eq(identities.subject, identity.subject)),
    )
    .limit(1)
    .then(first);
  return row?.account;
}

/**
 * The account an identity signs in as, created on its first sign-in; the
 * login is kept current. Of two first sign-ins racing, the identity's
 * primary key keeps one account and the other is removed.
 */
export async function upsertAccount(db: Db, identity: Identity, login: string): Promise<Account> {
  const found = await accountOf(db, identity);
  if (found) {
    if (found.login === login) return found;
    const [row] = await db
      .update(accounts)
      .set({ login })
      .where(eq(accounts.id, found.id))
      .returning();
    return row ?? found;
  }
  const id = crypto.randomUUID();
  await db.batch([
    db.insert(accounts).values({ id, login }),
    db
      .insert(identities)
      .values({ ...identity, accountId: id })
      .onConflictDoNothing(),
  ]);
  const owner = await accountOf(db, identity);
  if (owner?.id !== id) await db.delete(accounts).where(eq(accounts.id, id));
  if (!owner) throw new Error("account upsert found no account");
  return owner;
}

/** The GitHub user an account signs in as, if it does. */
export async function githubIdOf(db: Db, accountId: string): Promise<number | null> {
  const row = await db
    .select({ subject: identities.subject })
    .from(identities)
    .where(and(eq(identities.accountId, accountId), eq(identities.provider, "github")))
    .limit(1)
    .then(first);
  return row ? Number(row.subject) : null;
}

/** The login an account goes by, as its sessions show it. */
export async function loginOf(db: Db, accountId: string): Promise<string | null> {
  const row = await db
    .select({ login: accounts.login })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .then(first);
  return row?.login ?? null;
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
  db: Db,
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
    .limit(1)
    .then(first);
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
  db: Db,
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
    .limit(1)
    .then(first);
}

/**
 * Replaces a CLI session's tokens only while its refresh token is still
 * `currentRefreshHash`: of two refreshes racing with the same token, one wins.
 */
export async function rotateSession(
  db: Db,
  sessionId: string,
  currentRefreshHash: string,
  changes: Partial<typeof sessions.$inferInsert>,
): Promise<boolean> {
  const result = await db
    .update(sessions)
    .set(changes)
    .where(and(eq(sessions.id, sessionId), eq(sessions.refreshHash, currentRefreshHash)));
  return changedRows(result) > 0;
}

/** Ends a session, as when a refresh token is used again after its rotation. */
export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Ends the browser session with this token hash, if there is one. */
export async function revokeWebSession(db: Db, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.kind, "web")));
}

/** Deletes an account; its sessions, keys and records go with it (cascade). */
export async function deleteAccount(db: Db, accountId: string): Promise<void> {
  await db.delete(accounts).where(eq(accounts.id, accountId));
}

export async function setSharing(db: Db, accountId: string, on: boolean): Promise<void> {
  await db.update(accounts).set({ shareFindings: on }).where(eq(accounts.id, accountId));
}

/** The account's salt, made on first use (64 hex characters). */
export async function accountSalt(db: Db, accountId: string): Promise<string> {
  const row = await db
    .select({ salt: accounts.salt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .then(first);
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
    .limit(1)
    .then(first);
  return after?.salt ?? salt;
}
