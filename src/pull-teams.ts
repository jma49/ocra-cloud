import type { Db } from "./db/client.js";
import { ownUser } from "./notify/pull-events.js";
import type { CodePlatform } from "./platforms/platform.js";
import type { PlatformPull } from "./platforms/pulls.js";
import type { AppEnv } from "./types.js";

// Which pull requests the inbox lists for the user's review reached them
// through a team they are on, from what the enrolled repositories' webhooks
// recorded (src/db/review-requests.ts): an ask of the user themselves
// comes first, so such a pull request names no team.

/** Asks read per platform. */
const READ = 100;

const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/** One read per linked platform with a pull listed for review; answers each listed pull's team. */
export async function pullTeams(
  db: Db,
  data: AppEnv["Variables"]["data"],
  listed: readonly { platform: CodePlatform; linked: boolean; pulls: readonly PlatformPull[] }[],
  now = new Date(),
): Promise<(platform: CodePlatform, pull: PlatformPull) => string | undefined> {
  const found = new Map<CodePlatform, Map<string, string>>();
  for (const { platform, linked, pulls } of listed) {
    if (!linked || !pulls.some((p) => p.roles.includes("reviewer"))) continue;
    const me = await ownUser(db, data, { platform: platform.kind, host: platform.host });
    if (!me) continue;
    const u = { platform: platform.kind, host: platform.host, userId: me.id };
    const teams = new Map<string, string>();
    for (const w of await data.reviewRequests.askedOf(u, new Date(0), now, READ)) {
      if (w.team) teams.set(keyOf(w.repo, w.number), w.team);
    }
    found.set(platform, teams);
  }
  return (platform, pull) =>
    pull.roles.includes("reviewer") && !pull.roles.includes("author")
      ? found.get(platform)?.get(keyOf(pull.repo, pull.number))
      : undefined;
}
