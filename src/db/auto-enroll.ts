import { and, eq } from "drizzle-orm";
import { type Db, first } from "./client.js";
import { autoEnrollInstallations } from "./schema.js";

// The GitHub App installations whose added repositories an account enrolls
// (src/auto-review/auto-enroll.ts): the account's own switch, through
// scoped(), and the read a webhook makes before it knows the account.

type Installation = typeof autoEnrollInstallations.$inferSelect;
type OptIn = Pick<Installation, "host" | "installationId" | "owner" | "automatic">;

export function accountAutoEnroll(db: Db, accountId: string) {
  const t = autoEnrollInstallations;
  return {
    /**
     * Turns it on for this account, or updates this account's switch, in one
     * statement; false when another account has it (the unique index decides).
     */
    async optIn(row: OptIn): Promise<boolean> {
      const [kept] = await db
        .insert(t)
        .values({ id: crypto.randomUUID(), accountId, ...row })
        .onConflictDoUpdate({
          target: [t.host, t.installationId],
          set: { owner: row.owner, automatic: row.automatic },
          setWhere: eq(t.accountId, accountId),
        })
        .returning({ id: t.id });
      return kept !== undefined;
    },
  };
}

/** The installation's switch, whichever account turned it on. */
export function autoEnrollFor(
  db: Db,
  host: string,
  installationId: string,
): Promise<Installation | undefined> {
  const t = autoEnrollInstallations;
  return db
    .select()
    .from(t)
    .where(and(eq(t.host, host), eq(t.installationId, installationId)))
    .limit(1)
    .then(first);
}
