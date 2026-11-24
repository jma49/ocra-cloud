import type { Row, Scoped } from "../db/scoped.js";
import type { CiFailure } from "../notify/ci-hooks.js";
import { MAX_DAILY_FIX_REQUESTS } from "../shared/index.js";
import { MEND_DEBOUNCE_MS } from "./mend-round.js";

// The repository's own CI failing on a pull request's head starts a round
// of its fix loop over the failed checks (`ocra mend --checks`), where the
// repository lets the bot commit and asked for this. The round reads the
// checks itself: a check that passes again by then, or fails on the base
// branch too, leaves it nothing to do. The loop's own caps (rounds,
// attempts for a check that fails the same way, spend) end a failure the
// bot cannot fix; a head asks once, and a day's requests bound the rounds
// an account starts.

/** Pull requests of one head given a round at once, of one delivery. */
const MAX_PULLS = 5;

/** Whether the pull request is open, as the deliveries said: one closed and not reopened since is not. */
export async function pullIsOpen(data: Scoped, reviewRepoId: string, number: number) {
  const closed = await data.findOne("closedPulls", { reviewRepoId, number });
  const flow = closed && (await data.findOne("pullFlows", { reviewRepoId, number }));
  return !closed || !!(flow?.reopenedAt && closed.closedAt < flow.reopenedAt);
}

/** Queues a round for each pull request the failure names; how many it queued. */
export async function mendFailedChecks(
  data: Scoped,
  repo: Pick<Row<"reviewRepos">, "id" | "mend" | "mendChecks">,
  failure: CiFailure,
  now: Date,
): Promise<number> {
  if (repo.mend !== "commit" || !repo.mendChecks) return 0;
  let queued = 0;
  for (const number of failure.numbers.slice(0, MAX_PULLS)) {
    if (!(await pullIsOpen(data, repo.id, number))) continue;
    const asked = await data.mends.askChecks(
      { reviewRepoId: repo.id, number, head: failure.head },
      MAX_DAILY_FIX_REQUESTS,
      new Date(now.getTime() + MEND_DEBOUNCE_MS),
      now,
    );
    if (asked) queued++;
  }
  return queued;
}
