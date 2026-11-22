import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { accounts, identities, platformLinks } from "./schema.js";

// The login a platform user goes by, which says whom a comment's @-mention
// names (src/notify/pull-events.ts). A login can change, and a freed one be
// taken by someone else, and no webhook says whom a mention in a body means:
// so the login on record is refreshed, across accounts, whenever a webhook
// shows its user act under another; and a login more than one platform user
// is on record with names nobody.

/** The platform user a webhook shows acting: the platform's id and its login now. */
export type SeenUser = { id: string; login: string };

/** Keeps the login of a GitHub user who signs in to some account current. */
export async function refreshGithubLogin(db: Db, seen: SeenUser): Promise<void> {
  const signsIn = db
    .select({ accountId: identities.accountId })
    .from(identities)
    .where(and(eq(identities.provider, "github"), eq(identities.subject, seen.id)));
  await db
    .update(accounts)
    .set({ login: seen.login })
    .where(and(inArray(accounts.id, signsIn), ne(accounts.login, seen.login)));
}

/** Keeps the login of a GitLab user some account linked on the host current. */
export async function refreshGitlabLogin(db: Db, host: string, seen: SeenUser): Promise<void> {
  const t = platformLinks;
  await db
    .update(t)
    .set({ login: seen.login })
    .where(
      and(
        eq(t.platform, "gitlab"),
        eq(t.host, host),
        eq(t.userId, seen.id),
        or(isNull(t.login), ne(t.login, seen.login)),
      ),
    );
}

/** Whether a platform user other than the one of id is on record with the login, in any case. */
export async function loginShared(
  db: Db,
  platform: "github" | "gitlab",
  host: string,
  user: { id: string; login: string },
): Promise<boolean> {
  const login = user.login.toLowerCase();
  if (platform === "github") {
    const rows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .innerJoin(identities, eq(identities.accountId, accounts.id))
      .where(
        and(
          eq(identities.provider, "github"),
          ne(identities.subject, user.id),
          sql`lower(${accounts.login}) = ${login}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  const t = platformLinks;
  const rows = await db
    .select({ id: t.userId })
    .from(t)
    .where(
      and(
        eq(t.platform, platform),
        eq(t.host, host),
        isNotNull(t.userId),
        ne(t.userId, user.id),
        sql`lower(${t.login}) = ${login}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
