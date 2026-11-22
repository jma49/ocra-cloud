import { ownUser } from "./notify/pull-events.js";
import type { CodePlatform } from "./platforms/platform.js";
import type { PlatformPull } from "./platforms/pulls.js";
import type { PullSeenState } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// What the account last saw of each pull request the inbox lists, read in
// one query by the marks' unique index, and the replies waiting for it in
// the review threads its user started.

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

/**
 * How many review threads the user started on each listed pull request
 * have a reply from someone else newer than what the user last saw of it
 * (its mark's updatedAt, else since) and than their own last reply, read
 * from the threads kept from webhooks: no platform call.
 */
export async function pullRepliesWaiting(
  db: AppEnv["Variables"]["db"],
  data: AppEnv["Variables"]["data"],
  listed: readonly { platform: CodePlatform; pulls: readonly PlatformPull[] }[],
  seenOf: (platform: CodePlatform, pull: PlatformPull) => PullSeenState | undefined,
  since: number,
): Promise<(platform: CodePlatform, pull: PlatformPull) => number> {
  const waiting = new Map<string, number[]>();
  await Promise.all(
    listed.map(async ({ platform, pulls }) => {
      if (pulls.length === 0) return;
      const me = await ownUser(db, data, { platform: platform.kind, host: platform.host });
      if (me === null) return;
      const asked = pulls.map((p) => ({ repo: p.repo.toLowerCase(), number: p.number }));
      for (const t of await data.reviewThreads.waiting(platform, me.id, asked)) {
        const key = keyOf(platform.kind, t.repo, t.number);
        waiting.set(key, [...(waiting.get(key) ?? []), t.repliedAt]);
      }
    }),
  );
  return (platform, pull) => {
    const replies = waiting.get(keyOf(platform.kind, pull.repo, pull.number));
    if (!replies) return 0;
    const mark = seenOf(platform, pull);
    const seen = mark ? (mark.unread ? 0 : mark.updatedAt) : since;
    return replies.filter((at) => at > seen).length;
  };
}
