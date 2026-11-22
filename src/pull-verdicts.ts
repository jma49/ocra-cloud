import type { CodePlatform } from "./platforms/platform.js";
import { repoIdentity } from "./platforms/platform.js";
import type { PlatformPull } from "./platforms/pulls.js";
import type { PullAiVerdict } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// What the account's own reviews say of each pull request the inbox lists:
// a review names its pull request by the repository's identity, as the CLI
// writes it, and its number.

const identityOf = (platform: CodePlatform, repo: string) => {
  try {
    return repoIdentity(platform, repo).toLowerCase();
  } catch {
    return null;
  }
};

type OfReviews = { verdict: PullAiVerdict; reviewedAt: number | null };
const NONE: OfReviews = { verdict: null, reviewedAt: null };

/** Reads the verdicts in one query; answers each listed pull's, and when its newest review was made. */
export async function pullVerdicts(
  data: AppEnv["Variables"]["data"],
  listed: readonly { platform: CodePlatform; pulls: readonly PlatformPull[] }[],
): Promise<(platform: CodePlatform, pull: PlatformPull) => OfReviews> {
  const key = (repo: string, number: number) => `${repo}#${number}`;
  const wanted = new Map<string, { repo: string; number: number }>();
  for (const { platform, pulls } of listed) {
    for (const p of pulls) {
      const repo = identityOf(platform, p.repo);
      if (repo) wanted.set(key(repo, p.number), { repo, number: p.number });
    }
  }
  const found = new Map(
    (await data.pullViews.verdicts([...wanted.values()])).map((v) => [key(v.repo, v.number), v]),
  );
  return (platform, pull) => {
    const repo = identityOf(platform, pull.repo);
    const row = repo ? found.get(key(repo, pull.number)) : undefined;
    if (!row) return NONE;
    // significant_concerns is the verdict that blocks a merge.
    const verdict = row.verdict
      ? row.verdict === "significant_concerns"
        ? "blocking"
        : "not_blocking"
      : null;
    return { verdict, reviewedAt: row.reviewedAt };
  };
}
