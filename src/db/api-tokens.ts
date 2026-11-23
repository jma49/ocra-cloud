import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { ApiTokenScope } from "../shared/index.js";
import type { Account } from "./accounts.js";
import { changedRows, type Db } from "./client.js";
import { accounts, apiTokens } from "./schema.js";

// Personal API tokens: found by the hash of their secret before the account
// is known (as sessions are, in ./accounts.ts), otherwise reached only
// through scoped().

export type ApiTokenAccount = {
  account: Account;
  id: string;
  tokenHash: string;
  prefix: string;
  scopes: ApiTokenScope[];
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
};

/** The unexpired token with this hash, and its account. */
export async function apiTokenByHash(
  db: Db,
  tokenHash: string,
  now = new Date(),
): Promise<ApiTokenAccount | undefined> {
  const [row] = await db
    .select({
      account: accounts,
      id: apiTokens.id,
      tokenHash: apiTokens.tokenHash,
      prefix: apiTokens.prefix,
      scopes: apiTokens.scopes,
      createdAt: apiTokens.createdAt,
      expiresAt: apiTokens.expiresAt,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .innerJoin(accounts, eq(accounts.id, apiTokens.accountId))
    .where(and(eq(apiTokens.tokenHash, tokenHash), gt(apiTokens.expiresAt, now)))
    .limit(1);
  return row;
}

type NewToken = {
  id: string;
  name: string;
  tokenHash: string;
  prefix: string;
  scopes: ApiTokenScope[];
  expiresAt: Date;
};

export function accountApiTokens(db: Db, accountId: string) {
  const t = apiTokens;
  const own = (id: string) => and(eq(t.accountId, accountId), eq(t.id, id));
  return {
    /** Adds a token while the account holds fewer than cap, counted in the same statement. */
    async add(token: NewToken, cap: number): Promise<boolean> {
      const added = await db.run(sql`
        INSERT INTO ${t} (id, account_id, name, token_hash, prefix, scopes, expires_at)
        SELECT ${token.id}, ${accountId}, ${token.name}, ${token.tokenHash}, ${token.prefix},
          ${JSON.stringify(token.scopes)}, ${token.expiresAt.getTime()}
        WHERE (SELECT count(*) FROM ${t} WHERE account_id = ${accountId}) < ${cap}`);
      return changedRows(added) > 0;
    },

    /**
     * Records a use: at once the first time (true, so it is audited once
     * however many calls race), then only when the last recorded use is
     * older than everyMs. Compare-and-set, so concurrent calls write once.
     */
    async touch(id: string, now: Date, everyMs: number): Promise<boolean> {
      const first = await db
        .update(t)
        .set({ lastUsedAt: now })
        .where(and(own(id), isNull(t.lastUsedAt)))
        .returning({ id: t.id });
      if (first.length > 0) return true;
      await db
        .update(t)
        .set({ lastUsedAt: now })
        .where(and(own(id), lt(t.lastUsedAt, new Date(now.getTime() - everyMs))));
      return false;
    },

    /** The account's tokens still live, newest first. */
    live(now: Date) {
      return db
        .select()
        .from(t)
        .where(and(eq(t.accountId, accountId), gt(t.expiresAt, now)))
        .orderBy(sql`${t.createdAt} desc`)
        .limit(100);
    },
  };
}
