import { claimAutomationRetry } from "../db/automations.js";
import type { Db } from "../db/client.js";
import { scoped } from "../db/scoped.js";
import type { BotTokens } from "../platforms/bot.js";
import type { CodePlatform } from "../platforms/platform.js";
import { botOf, botWrite, MAX_ATTEMPTS, resultOf, retryOf } from "./run.js";

// The bot's writes the platform did not answer, tried again with backoff
// until MAX_ATTEMPTS: each attempt claimed by one runner (claimAutomationRetry),
// and only the actions still unanswered sent. Only a server with a bot
// writes, so only the Node host's loop runs this.

/** A runner that dies mid-attempt leaves the run to the next one after this. */
const LEASE_MS = 5 * 60_000;
/** Runs tried per sweep; the rest wait for the next. */
const PER_SWEEP = 20;

export type RetryRunner = { db: Db; bots: BotTokens; platforms: readonly CodePlatform[] };

/** Tries the runs due again; how many it tried. */
export async function retryAutomations(runner: RetryRunner, now = () => new Date()) {
  let tried = 0;
  for (; tried < PER_SWEEP; tried++) {
    const run = await claimAutomationRetry(runner.db, now(), LEASE_MS, MAX_ATTEMPTS);
    if (!run) break;
    const data = scoped(runner.db, run.accountId);
    const repo = (await data.get("reviewRepos", run.retry.reviewRepoId)) ?? null;
    const bot = botOf(runner, repo);
    const actions = [...run.actions];
    for (const { index, action } of run.retry.actions) {
      const done = actions[index];
      if (!done || action.kind === "notify" || action.kind === "skip_review") continue;
      const outcome = repo
        ? await botWrite(bot, repo.fullName, run.retry.number, action)
        : "not_enrolled";
      actions[index] = { kind: done.kind, outcome };
    }
    const retry = retryOf(run.retry.reviewRepoId, run.retry.number, run.retry.actions, actions);
    await data.automations.finish(
      run.id,
      run.attempts,
      resultOf(actions, retry, run.attempts, now()),
    );
  }
  return tried;
}
