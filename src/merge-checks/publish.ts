import type { Db } from "../db/client.js";
import { scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import type { Outbox } from "../notify/notify.js";
import { tellChecksFailed } from "../notify/pull-events.js";
import type { BotTokens } from "../platforms/bot.js";
import type { CodePlatform } from "../platforms/platform.js";
import { consolePullUrl, digestOf, evaluatePull, heldBySpend, statusOf } from "./run.js";

// Posting a pull request's checks as the ocra bot, where the host has one
// (src/node/): evaluated on its current head, stored per head, and posted
// only by the caller whose compare-and-set took that result, so a webhook
// and an upload landing together post it once.

export type ChecksPoster = {
  db: Db;
  platforms: readonly CodePlatform[];
  bots: BotTokens;
  publicUrl: string;
  /** Where the author is told of failed checks; nobody is without it. */
  outbox?: Outbox;
};

export type PostOutcome = "posted" | "unchanged" | "skipped" | "failed";

export async function postChecks(
  poster: ChecksPoster,
  accountId: string,
  reviewRepoId: string,
  number: number,
  now = new Date(),
): Promise<PostOutcome> {
  const data = scoped(poster.db, accountId);
  const repo = await data.get("reviewRepos", reviewRepoId);
  const platform =
    repo && poster.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  if (!repo || !platform) return "skipped";
  const bot = await poster.bots.forRepo(repo);
  if (!bot) return "skipped";
  const evaluated = await evaluatePull(data, platform, bot.token, repo, number);
  if (!evaluated.report) return evaluated.reason === "unreachable" ? "failed" : "skipped";
  const { report } = evaluated;
  const held = await heldBySpend(data, report, now);
  const digest = await digestOf(report, held);
  const checks = data.mergeChecks;
  const id = await checks.record(
    {
      reviewRepoId,
      number,
      head: report.head,
      conclusion: report.conclusion,
      results: report.results,
      digest,
    },
    now,
  );
  if (!id || !(await checks.claimPost(id, digest))) return "unchanged";
  const run = await data.get("mergeCheckRuns", id);
  const status = statusOf(report, consolePullUrl(poster.publicUrl, repo, number), held);
  if (report.conclusion === "failure" && poster.outbox) {
    const pull = { number, head: report.head, summary: status.title };
    await tellChecksFailed(poster.db, data, poster.outbox, repo, pull).catch((e) =>
      logError("notify_failed", { error: errorName(e) }),
    );
  }
  const external = await platform.mergeStatus.publish(
    bot.token,
    repo.fullName,
    report.head,
    status,
    run?.externalId ?? null,
  );
  if (!external) {
    await checks.releasePost(id, digest);
    return "failed";
  }
  await data.update("mergeCheckRuns", id, { externalId: external, postedAt: now });
  return "posted";
}
