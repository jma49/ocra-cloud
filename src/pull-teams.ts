import type { Db } from "./db/client.js";
import { ownUser } from "./notify/pull-events.js";
import type { CodePlatform } from "./platforms/platform.js";
import type { PlatformPull, TeamAsk } from "./platforms/pulls.js";
import type { AppEnv } from "./types.js";

// Which pull requests wait for the user's review through a team they are
// on, from what the enrolled repositories' webhooks recorded
// (src/db/review-requests.ts): read before the platform's listing, which
// lists those its own lists miss (a GitLab approval rule's group), and
// then names the team on each. An ask of the user themselves comes first,
// so such a pull request names no team.

/** Asks read per platform. */
const READ = 100;

const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/** One read for the linked platform: the waiting asks of a team the user is on, waiting longest first. */
export async function teamAsks(
  db: Db,
  data: AppEnv["Variables"]["data"],
  platform: CodePlatform,
  now = new Date(),
): Promise<TeamAsk[]> {
  const me = await ownUser(db, data, { platform: platform.kind, host: platform.host });
  if (!me) return [];
  const u = { platform: platform.kind, host: platform.host, userId: me.id };
  return (await data.reviewRequests.askedOf(u, new Date(0), now, READ)).flatMap((w) =>
    w.team ? [{ repo: w.repo, number: w.number, team: w.team }] : [],
  );
}

/** Each listed pull's team, from its platform's asks. */
export function pullTeams(
  listed: readonly { platform: CodePlatform; asks: readonly TeamAsk[] }[],
): (platform: CodePlatform, pull: PlatformPull) => string | undefined {
  const found = new Map(
    listed.map((l) => [l.platform, new Map(l.asks.map((a) => [keyOf(a.repo, a.number), a.team]))]),
  );
  return (platform, pull) =>
    pull.roles.includes("reviewer") && !pull.roles.includes("author")
      ? found.get(platform)?.get(keyOf(pull.repo, pull.number))
      : undefined;
}
