import type { Row, Scoped } from "../db/scoped.js";
import type { CodePlatform } from "../platforms/platform.js";
import { platformOfPull, pullOfReview } from "../review-pull.js";
import type { AutomationEvent } from "./run.js";

// A pull request's uploaded review as an automation event. The bot writes
// only on a repository this account enrolled: an upload names any
// repository it likes, so naming one is no proof the account reaches it.

export async function reviewedEvent(
  data: Scoped,
  review: Row<"reviews">,
  platforms: readonly CodePlatform[],
  consoleUrl: string,
): Promise<AutomationEvent | undefined> {
  const pull = pullOfReview(review);
  if (!pull) return undefined;
  const platform = platformOfPull(platforms, pull);
  const repo = platform
    ? await data.findOne("reviewRepos", {
        platform: platform.kind,
        host: platform.host,
        fullName: pull.repo,
      })
    : undefined;
  return {
    trigger: "reviewed",
    eventKey: `review:${review.id}`,
    repo: repo ?? null,
    pull: { host: platform?.host ?? pull.host, fullName: pull.repo, number: pull.number },
    facts: {
      ...(repo ? { repoId: repo.id } : {}),
      critical: review.critical > 0,
      ...(review.verdict ? { verdict: review.verdict } : {}),
    },
    acts: true,
    consoleUrl,
  };
}
