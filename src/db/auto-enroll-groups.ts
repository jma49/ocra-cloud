import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { type Db, first } from "./client.js";
import { autoEnrollGroups } from "./schema.js";

// The GitLab groups whose new projects an account enrolls
// (src/auto-review/group-sweep.ts): the account's own switch, through
// scoped(), and the sweep's turn across accounts, claimed once a day by a
// compare-and-set on when it was last claimed, so two runs at once read a
// group once.

type Group = typeof autoEnrollGroups.$inferSelect;
type OptIn = Pick<Group, "host" | "groupId" | "fullPath" | "automatic" | "lastProjectId">;

const DAY_MS = 24 * 60 * 60_000;

export function accountAutoEnrollGroups(db: Db, accountId: string) {
  const t = autoEnrollGroups;
  return {
    /**
     * Turns it on for this account, or updates this account's switch (its
     * newest project seen stays), in one statement; false when another
     * account has the group (the unique index decides).
     */
    async optIn(row: OptIn): Promise<boolean> {
      const [kept] = await db
        .insert(t)
        .values({ id: crypto.randomUUID(), accountId, ...row })
        .onConflictDoUpdate({
          target: [t.host, t.groupId],
          set: { fullPath: row.fullPath, automatic: row.automatic },
          setWhere: eq(t.accountId, accountId),
        })
        .returning({ id: t.id });
      return kept !== undefined;
    },
  };
}

export type GroupTurn = Group & { previous: Date | null };

/** Claims the group not swept for a day that waited longest; undefined when none is due. */
export async function claimGroupSweep(db: Db, now: Date): Promise<GroupTurn | undefined> {
  const t = autoEnrollGroups;
  const due = or(isNull(t.sweptAt), lt(t.sweptAt, new Date(now.getTime() - DAY_MS)));
  for (let tries = 0; tries < 3; tries++) {
    const next = await db
      .select({ id: t.id, sweptAt: t.sweptAt })
      .from(t)
      .where(due)
      .orderBy(sql`coalesce(${t.sweptAt}, 0)`, asc(t.id))
      .limit(1)
      .then(first);
    if (!next) return undefined;
    const was = next.sweptAt ? eq(t.sweptAt, next.sweptAt) : isNull(t.sweptAt);
    const claimed = await db
      .update(t)
      .set({ sweptAt: now })
      .where(and(eq(t.id, next.id), was))
      .returning()
      .then(first);
    if (claimed) return { ...claimed, previous: next.sweptAt };
  }
  return undefined;
}

/** Gives a claim back, so the next run sweeps the group again. */
export async function releaseGroupSweep(db: Db, turn: GroupTurn): Promise<void> {
  const t = autoEnrollGroups;
  await db
    .update(t)
    .set({ sweptAt: turn.previous })
    .where(and(eq(t.id, turn.id), eq(t.sweptAt, turn.sweptAt ?? new Date(0))));
}
