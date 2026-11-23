import { membersOf, membersText, type TeamKey } from "../db/review-teams.js";
import type { Scoped } from "../db/scoped.js";
import type { BotTokens } from "../platforms/bot.js";
import { HOUR } from "../time.js";

// Who is on a team a review was asked of: the copy kept for the account
// while it is younger than TEAM_TTL, else one read of the platform's list
// with the App's Members permission (src/platforms/bot-tokens.ts), kept
// whatever it answered. A refusal or a deployment without the App reads as
// no members, never an error: the team's ask then reaches nobody.

const TEAM_TTL = 24 * HOUR;

export type AskedTeam = TeamKey & { org: string; slug: string };

/** The platform ids of the team's members; null when the platform did not tell. */
export async function teamMembers(
  data: Scoped,
  bots: BotTokens | undefined,
  team: AskedTeam,
  now = new Date(),
): Promise<string[] | null> {
  const kept = await data.reviewTeams.find(team);
  if (kept && now.getTime() - kept.fetchedAt.getTime() < TEAM_TTL) return membersOf(kept.members);
  if (team.platform !== "github" || !bots?.teamMembers)
    return kept ? membersOf(kept.members) : null;
  const members = await bots.teamMembers(team.org, team.slug);
  await data.reviewTeams.keep({ ...team, name: `${team.org}/${team.slug}`, members, at: now });
  return members === null ? null : membersOf(membersText(members));
}
