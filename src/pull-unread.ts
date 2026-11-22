import type { CodePlatform } from "./platforms/platform.js";
import type { PlatformPull } from "./platforms/pulls.js";
import type { PullSeenState } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// What the account last saw of each pull request the inbox lists, read in
// one query by the marks' unique index.

const keyOf = (platform: string, repo: string, number: number) =>
  `${platform}:${repo.toLowerCase()}#${number}`;

export async function pullSeenStates(
  data: AppEnv["Variables"]["data"],
  listed: readonly { platform: CodePlatform; pulls: readonly PlatformPull[] }[],
): Promise<(platform: CodePlatform, pull: PlatformPull) => PullSeenState | undefined> {
  const wanted = new Map<
    string,
    { platform: CodePlatform["kind"]; repo: string; number: number }
  >();
  for (const { platform, pulls } of listed) {
    for (const p of pulls) {
      const repo = p.repo.toLowerCase();
      wanted.set(keyOf(platform.kind, repo, p.number), {
        platform: platform.kind,
        repo,
        number: p.number,
      });
    }
  }
  const found = new Map(
    (await data.pullSeen.markers([...wanted.values()])).map((m) => [
      keyOf(m.platform, m.repo, m.number),
      { updatedAt: m.updatedAt, head: m.head, unread: m.unread, seenAt: m.seenAt },
    ]),
  );
  return (platform, pull) => found.get(keyOf(platform.kind, pull.repo, pull.number));
}
