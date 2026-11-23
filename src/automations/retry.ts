import { type CallBudget, item, uncapped } from "../calls.js";
import { claimAutomationRetry } from "../db/automations.js";
import type { Db } from "../db/client.js";
import { scoped } from "../db/scoped.js";
import type { BotTokens } from "../platforms/bot.js";
import type { CodePlatform } from "../platforms/platform.js";
import { botOf, botWrite, isRetried, MAX_ATTEMPTS, resultOf, retryOf } from "./run.js";

// The bot's writes the platform did not answer, tried again with backoff
// until MAX_ATTEMPTS: each attempt claimed by one runner (claimAutomationRetry),
// and only the actions still unanswered sent. Every host with a bot runs it:
// the Node server's timer, and the Worker's hourly run within its budget of
// calls (src/cron-calls.ts), where an attempt the budget cut short is given
// back uncounted, keeping the writes that were answered.

/** A runner that dies mid-attempt leaves the run to the next one after this. */
const LEASE_MS = 5 * 60_000;
/** Runs tried per sweep; the rest wait for the next. */
const PER_SWEEP = 20;

export type RetryRunner = { db: Db; bots: BotTokens; platforms: readonly CodePlatform[] };

/** What an attempt takes at least: the bot's token (three calls for a GitHub App) and one write. */
const FEWEST_CALLS = 4;

/** Tries the runs due again, while `calls` has room for one more; how many it tried. */
export async function retryAutomations(
  runner: RetryRunner,
  now = () => new Date(),
  calls: CallBudget = uncapped(),
) {
  let tried = 0;
  while (tried < PER_SWEEP && calls.has(FEWEST_CALLS)) {
    const run = await claimAutomationRetry(runner.db, now(), LEASE_MS, MAX_ATTEMPTS);
    if (!run) break;
    tried++;
    const data = scoped(runner.db, run.accountId);
    const repo = (await data.get("reviewRepos", run.retry.reviewRepoId)) ?? null;
    const bot = botOf(runner, repo);
    const actions = [...run.actions];
    let cut = false;
    for (const { index, action } of run.retry.actions) {
      const done = actions[index];
      // An assignment is retried as the request of the logins it chose (./assign.ts).
      if (!done || !isRetried(action)) continue;
      if (!repo) {
        actions[index] = { kind: done.kind, outcome: "not_enrolled" };
        continue;
      }
      const went = await item(() => botWrite(bot, repo.fullName, run.retry.number, action));
      // A call the budget refused is no answer: this write and those after it stay unanswered.
      if (went.cut) {
        cut = true;
        break;
      }
      actions[index] = { kind: done.kind, outcome: went.value };
    }
    const retry = retryOf(run.retry.reviewRepoId, run.retry.number, run.retry.actions, actions);
    if (cut) {
      const at = now();
      const result = resultOf(actions, retry, run.attempts - 1, at);
      await data.automations.giveBack(run.id, run.attempts, { ...result, retryAt: at });
      break;
    }
    await data.automations.finish(
      run.id,
      run.attempts,
      resultOf(actions, retry, run.attempts, now()),
    );
  }
  return tried;
}
