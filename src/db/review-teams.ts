import { and, eq, like, sql } from "drizzle-orm";
import type { CodePlatformKind as CodePlatform } from "../shared/index.js";
import type { Db } from "./client.js";
import { reviewTeams } from "./schema.js";

// Who is on the teams reviews were asked of (src/auto-review/teams.ts). A
// team's members are one text of their platform ids, ",1,2,", so that a
// query finds a member's teams with LIKE on every dialect.

export type TeamKey = { platform: CodePlatform; host: string; reviewerId: string };

/** At most this many members are kept per team: ten pages of the platform's list. */
const MAX_TEAM_MEMBERS = 1000;
const MAX_NAME = 255;
const t = reviewTeams;

/** The reviewer id of a team's asks in review_requests; a user's is their bare id. */
export const teamReviewerId = (teamId: number | string) => `team:${teamId}`;
export const TEAM_PREFIX = "team:";

/** A platform id that can stand in the members text: digits only. */
export const memberIdOk = (id: string) => /^\d{1,20}$/.test(id);

export const membersText = (ids: readonly string[]) => {
  const kept = [...new Set(ids.filter(memberIdOk))].slice(0, MAX_TEAM_MEMBERS);
  return `,${kept.join(",")},`;
};

export const membersOf = (text: string | null): string[] | null =>
  text === null ? null : text.split(",").filter((id) => id !== "");

/** The condition that the members text column holds userId. */
export const hasMember = (column: typeof t.members, userId: string) =>
  like(column, `%,${userId},%`);

export function accountReviewTeams(db: Db, accountId: string) {
  return {
    async find(k: TeamKey) {
      const [row] = await db
        .select()
        .from(t)
        .where(
          and(
            eq(t.accountId, accountId),
            eq(t.platform, k.platform),
            eq(t.host, k.host),
            eq(t.reviewerId, k.reviewerId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    /** Keeps what the platform said of the team at `at`: its members, or null when it was refused. */
    async keep(k: TeamKey & { name: string; members: readonly string[] | null; at: Date }) {
      const members = k.members === null ? null : membersText(k.members);
      const name = k.name.slice(0, MAX_NAME);
      await db
        .insert(t)
        .values({
          id: crypto.randomUUID(),
          accountId,
          platform: k.platform,
          host: k.host,
          reviewerId: k.reviewerId,
          name,
          members,
          fetchedAt: k.at,
        })
        .onConflictDoUpdate({
          target: [t.accountId, t.platform, t.host, t.reviewerId],
          set: { name, members, fetchedAt: k.at },
          // An answer read earlier than the one kept never replaces it.
          setWhere: sql`${t.fetchedAt} <= ${k.at.getTime()}`,
        });
    },
  };
}
