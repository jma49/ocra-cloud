import { callsRefused } from "../calls.js";
import { membersOf, membersText, type TeamKey } from "../db/review-teams.js";
import type { Scoped } from "../db/scoped.js";
import { HOUR } from "../time.js";

// Who is on a team (a GitHub team, a GitLab group) a review was asked of:
// the copy kept for the account while it is younger than TEAM_TTL, else one
// read of the platform's list (GitHub's with the App's Members permission,
// src/platforms/bot-tokens.ts; GitLab's as the bot or the enrolling link,
// src/notify/gitlab-groups.ts), kept whatever it answered. A refusal or no
// way to read reads as no members, never an error: the ask then reaches
// nobody. A read the run's call budget cut short is no answer and is not kept.

const TEAM_TTL = 24 * HOUR;

/** A team as the platform names it (org/slug, a group's full path). */
export type AskedTeam = TeamKey & { name: string };

/** The platform's list of a team's member ids; null when it did not tell. */
export type ReadMembers = () => Promise<string[] | null>;

/** The platform ids of the team's members; null when the platform did not tell. */
export async function teamMembers(
  data: Scoped,
  read: ReadMembers | null,
  team: AskedTeam,
  now = new Date(),
): Promise<string[] | null> {
  const kept = await data.reviewTeams.find(team);
  const keptMembers = kept ? membersOf(kept.members) : null;
  if (kept && now.getTime() - kept.fetchedAt.getTime() < TEAM_TTL) return keptMembers;
  if (!read) return keptMembers;
  const members = await read();
  if (callsRefused()) return keptMembers;
  await data.reviewTeams.keep({ ...team, members, at: now });
  return members === null ? null : membersOf(membersText(members));
}
