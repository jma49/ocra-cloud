import { audit } from "../audit.js";
import type { RunFailure } from "../auto-review/work.js";
import type { Db } from "../db/client.js";
import { JOB_ATTEMPTS } from "../db/job-recovery.js";
import { claimRestack } from "../db/restack-jobs.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import type { BotCredential, BotTokens } from "../platforms/bot.js";
import type { CodePlatform } from "../platforms/platform.js";
import { gitlabTokenRejected, hasRepoToken } from "../platforms/repo-token.js";
import { MAX_STACK } from "../platforms/stacks.js";
import type { CodePlatformKind, RestackOutcome, RestackSkip } from "../shared/index.js";
import { queueRestacks } from "./restack.js";

// The server's half of a restack (./restack.ts): claiming the next one,
// giving its run the bot's credential that may push and what to rebase,
// and recording how it went: the force-push audited, the layers above a
// restacked one queued next, and a conflict told on the pull request.
// The run itself is the machine's (src/node/restack-run.ts).

/** A clone, a rebase and one push. */
const RESTACK_LEASE_MS = 10 * 60_000;
const RETRY_AFTER_MS = 5 * 60_000;

export type RestackRef = { id: string; accountId: string; attempts: number };

/** Everything one restack's run needs, and nothing that outlives it. */
export type RestackAssignment = RestackRef & {
  leaseUntil: Date;
  repo: { platform: CodePlatformKind; url: string; fullName: string };
  bot: BotCredential;
  restack: {
    branch: string;
    /** The head the branch must still be at: the push's lease. */
    head: string;
    onto: { branch: string; commit: string | null };
    /** The parent's old head: the commits up to it are dropped. */
    upstream: string;
    /** Asked for by hand: the run drops what the branch shares with its new base instead. */
    fork: boolean;
  };
};

/** What a run found: `head` is what it pushed. */
export type RestackResult =
  | { outcome: "restacked"; head: string }
  | { outcome: "conflict" | "lease_lost" }
  | { outcome: "skipped"; reason: Extract<RestackSkip, "up_to_date" | "push_refused"> };

export type RestackSource = {
  db: Db;
  platforms: readonly CodePlatform[];
  bots: BotTokens;
  recover?: boolean;
  now?: () => Date;
};

type Failure = "repo_gone" | "platform_gone" | "no_bot" | "token_rejected" | RunFailure;

/**
 * Claims the next due restack and prepares its run. Undefined when none is
 * due; "refused" when it ended without a run (its repository, platform or
 * bot gone, restacks turned off, a stack merge holding the pull request).
 */
export async function assignRestack(
  source: RestackSource,
): Promise<RestackAssignment | "refused" | undefined> {
  const now = source.now ?? (() => new Date());
  const job = await claimRestack(source.db, now(), RESTACK_LEASE_MS, source.recover);
  if (!job) return undefined;
  const ref = { id: job.id, accountId: job.accountId, attempts: job.attempts };
  const data = scoped(source.db, job.accountId);
  const repo = await data.get("reviewRepos", job.reviewRepoId);
  const platform = repo && platformOf(source, repo);
  const bot = platform && (await source.bots.forRepo(repo, "commit"));
  if (!repo || !platform || !bot) {
    const failure = !repo ? "repo_gone" : !platform ? "platform_gone" : "no_bot";
    await settleRestack(source, ref, { failure }, now());
    return "refused";
  }
  const skip = !repo.restack
    ? "switched_off"
    : (await data.stackMerges.heldBy(repo, [job.number]))
      ? "stack_merge"
      : null;
  if (skip) {
    await data.restacks.finish(job.id, job.attempts, "skipped", null, skip, now());
    return "refused";
  }
  if (
    repo.platform === "gitlab" &&
    hasRepoToken(repo) &&
    (await gitlabTokenRejected(platform.url, bot.token))
  ) {
    await settleRestack(source, ref, { failure: "token_rejected" }, now());
    return "refused";
  }
  return {
    ...ref,
    leaseUntil: job.leaseUntil,
    repo: { platform: platform.kind, url: platform.url, fullName: repo.fullName },
    bot,
    restack: {
      branch: job.branch,
      head: job.head,
      onto: { branch: job.ontoBranch, commit: job.ontoCommit },
      upstream: job.upstream,
      fork: job.askedBy !== null,
    },
  };
}

const platformOf = (source: Pick<RestackSource, "platforms">, repo: Row<"reviewRepos">) =>
  source.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);

/**
 * Records how the restack's run went, only while it is still this
 * attempt's: a clone that failed is tried again later; what the run found
 * ends it, and its consequences follow.
 */
export async function settleRestack(
  source: RestackSource,
  ref: RestackRef,
  ran: RestackResult | { failure: Failure },
  now: Date,
): Promise<void> {
  const data = scoped(source.db, ref.accountId);
  if ("failure" in ran) {
    const retry = ran.failure === "clone_failed" && ref.attempts < JOB_ATTEMPTS;
    logError("restack_job_failed", { job: ref.id, reason: ran.failure, retry });
    const retryAt = retry ? new Date(now.getTime() + RETRY_AFTER_MS * ref.attempts) : null;
    await data.restacks.release(ref.id, ref.attempts, ran.failure, retryAt, now);
    return;
  }
  const pushed = ran.outcome === "restacked" ? ran.head : null;
  const reason = ran.outcome === "skipped" ? ran.reason : null;
  if (!(await data.restacks.finish(ref.id, ref.attempts, ran.outcome, pushed, reason, now))) {
    return;
  }
  try {
    await followUp(source, data, ref.id, ran.outcome, pushed);
  } catch (e) {
    logError("restack_follow_up_failed", { job: ref.id, error: errorName(e) });
  }
}

async function followUp(
  source: RestackSource,
  data: Scoped,
  id: string,
  outcome: RestackOutcome,
  pushed: string | null,
): Promise<void> {
  if (outcome !== "restacked" && outcome !== "conflict") return;
  const job = await data.get("restackJobs", id);
  const repo = job && (await data.get("reviewRepos", job.reviewRepoId));
  if (!job || !repo) return;
  const pull = `${repo.fullName}#${job.number}`;
  if (pushed) {
    await audit(data, "stack.force_pushed", {
      pull,
      base: job.ontoBranch,
      head: job.head,
      pushed,
    });
  }
  const platform = platformOf(source, repo);
  const bot = platform && (await source.bots.forRepo(repo));
  if (!platform || !bot) return;
  if (pushed) {
    // The layers stacked on this one carry its old commits now: they go next, onto its new head.
    const above = await platform.stacks.children(bot.token, repo.fullName, job.branch);
    const parent = {
      number: job.number,
      merge: job.parentMerge,
      head: job.head,
      onto: { branch: job.branch, commit: pushed },
    };
    await queueRestacks(data, repo, parent, (above ?? []).slice(0, MAX_STACK));
    return;
  }
  const mark = repo.platform === "gitlab" ? "!" : "#";
  await platform.actions.comment(
    bot.token,
    repo.fullName,
    job.number,
    `ocra could not restack this branch onto \`${job.ontoBranch}\` after the one below it ` +
      `(${mark}${job.parent}) changed: the rebase conflicts, so nothing was pushed. ` +
      "Run `ocra stack restack` locally and push the result.",
  );
}
