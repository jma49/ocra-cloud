import { loginOf } from "../db/accounts.js";
import type { Db } from "../db/client.js";
import { claimGenerate } from "../db/generate-jobs.js";
import { claimReply } from "../db/reply-jobs.js";
import { claimJob } from "../db/review-jobs.js";
import { scoped } from "../db/scoped.js";
import { logError } from "../log.js";
import { engineMergeChecks } from "../merge-checks/instruction.js";
import { checksOf } from "../merge-checks/run.js";
import type { BotAccess, BotCredential, BotTokens } from "../platforms/bot.js";
import type { CodePlatform } from "../platforms/platform.js";
import { startCliSession } from "../session.js";
import { type CodePlatformKind, DAILY_LIMIT_WAIT } from "../shared/index.js";
import { nextUtcDay, utcDay } from "../time.js";
import { profileRun } from "./profiles.js";

// The server's half of a hosted job (ADR-0046, 4): claiming the next queued
// review, answer to an @ocra comment or request for tests or docstrings,
// giving its run what it needs (the bot's credential, a CLI session of the
// enrolling account, the CLI's arguments and configuration) and recording
// how it went. The run itself, a clone and the released CLI, is the
// machine's half (src/node/review-runner.ts), in this process or on a
// remote runner (./runner-api.ts).

export const WORK_KINDS = ["review", "reply", "generate"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** Why a run ended without its result; the last three are the machine's to report. */
export const RUN_FAILURES = ["clone_failed", "review_failed", "not_committed"] as const;
export type RunFailure = (typeof RUN_FAILURES)[number];
type Failure = "repo_gone" | "platform_gone" | "no_bot" | RunFailure;
const RETRIED: ReadonlySet<Failure> = new Set(["clone_failed", "review_failed"]);

/** A review's run, clone included; the CLI's own run timeout is shorter. */
const LEASE_MS = 45 * 60_000;
/** An answer is one model call or a few: far shorter than a review. */
const REPLY_LEASE_MS = 10 * 60_000;
/** A few model calls, one per file it writes for, and one commit. */
const GENERATE_LEASE_MS = 20 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 5 * 60_000;

/** The job a run answers for: settled only while it is still this attempt's. */
export type WorkRef = { kind: WorkKind; id: string; accountId: string; attempts: number };

/** Everything one run needs, and nothing that outlives it. */
export type Assignment = WorkRef & {
  leaseUntil: Date;
  repo: { platform: CodePlatformKind; url: string; fullName: string };
  bot: BotCredential;
  /** The server the CLI signs in to, and the account's session there. */
  cloudUrl: string;
  credentials: Record<string, string | number>;
  /** The CLI's arguments, before the path of its configuration file. */
  args: string[];
  config: Record<string, unknown>;
  /** Exit codes that mean done, and those that end the job without a retry. */
  ok: number[];
  settled: number[];
};

export type WorkSource = {
  db: Db;
  platforms: readonly CodePlatform[];
  bots: BotTokens;
  /** This server's own address, which the CLI signs in to. */
  publicUrl: string;
  /** The service's daily cap on an account's gateway calls: an account at it waits. */
  dailyCalls: number;
  /** A review's lease, when not the default. */
  leaseMs?: number;
  now?: () => Date;
};

type Claimed = { id: string; accountId: string; reviewRepoId: string; number: number };
type Command = {
  args: (pull: string[]) => string[];
  ok: number[];
  settled?: number[];
  access?: BotAccess;
  mergeChecks?: true;
  /** Whether the repository's review profile applies (src/shared/review-profiles.ts). */
  profile?: true;
};

type ClaimedWork = Claimed & { attempts: number; leaseUntil: Date };

async function claim(
  source: WorkSource,
  kind: WorkKind,
  now: Date,
): Promise<{ claimed: ClaimedWork; command: Command } | undefined> {
  if (kind === "review") {
    const claimed = await claimJob(source.db, now, source.leaseMs ?? LEASE_MS, source.dailyCalls);
    return (
      claimed && {
        claimed,
        command: {
          args: (pull) => ["review", ...pull, "--publish", "--no-repo-config"],
          // The CLI's exit codes for a review it finished and posted: ok, blocking, incomplete.
          ok: [0, 1, 3],
          mergeChecks: true,
          profile: true,
        },
      }
    );
  }
  if (kind === "reply") {
    const claimed = await claimReply(source.db, now, REPLY_LEASE_MS, source.dailyCalls);
    return (
      claimed && {
        claimed,
        command: {
          args: (pull) => [
            "reply",
            ...pull,
            "--comment",
            claimed.commentId,
            ...(claimed.inline ? ["--inline"] : []),
          ],
          ok: [0],
        },
      }
    );
  }
  const claimed = await claimGenerate(source.db, now, GENERATE_LEASE_MS, source.dailyCalls);
  return (
    claimed && {
      claimed,
      command: {
        args: (pull) => ["generate", claimed.kind, ...pull],
        ok: [0],
        // `ocra generate` wrote edits it could not commit: the branch moved, or the bot cannot push to it.
        settled: [3],
        access: "commit",
      },
    }
  );
}

/**
 * Claims the kind's next due job and prepares its run. Undefined when none
 * is due; "refused" when the job could not be given a run (its repository,
 * platform or bot is gone), which is recorded on it.
 */
export async function assign(
  source: WorkSource,
  kind: WorkKind,
): Promise<Assignment | "refused" | undefined> {
  const now = source.now ?? (() => new Date());
  const work = await claim(source, kind, now());
  if (!work) return undefined;
  const { claimed, command } = work;
  const ref = { kind, id: claimed.id, accountId: claimed.accountId, attempts: claimed.attempts };
  const data = scoped(source.db, claimed.accountId);
  const repo = await data.get("reviewRepos", claimed.reviewRepoId);
  const platform =
    repo && source.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  const bot = platform && (await source.bots.forRepo(repo.platform, repo.fullName, command.access));
  if (!repo || !platform || !bot) {
    await settle(source, ref, !repo ? "repo_gone" : !platform ? "platform_gone" : "no_bot", now());
    return "refused";
  }
  const mergeChecks = command.mergeChecks
    ? await engineMergeChecks(await checksOf(data, repo.id))
    : [];
  const profile = command.profile ? profileRun(repo.reviewProfile) : { config: {}, flags: [] };
  const pull =
    platform.kind === "github"
      ? ["--pr", String(claimed.number), "--repo", repo.fullName]
      : ["--mr", String(claimed.number), "--project", repo.fullName];
  // A run that died left its session behind: this attempt's replaces it.
  await data.remove("sessions", claimed.id);
  const tokens = await startCliSession(source.db, claimed.accountId, "auto review", claimed.id);
  return {
    ...ref,
    leaseUntil: claimed.leaseUntil,
    repo: { platform: platform.kind, url: platform.url, fullName: repo.fullName },
    bot,
    cloudUrl: source.publicUrl,
    credentials: {
      server: new URL(source.publicUrl).origin,
      login: (await loginOf(source.db, claimed.accountId)) ?? "",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      lifetime_ms: tokens.expires_in * 1000,
    },
    args: [...command.args(pull), ...profile.flags],
    config: {
      ...profile.config,
      ...(bot.login ? { github: { botLogin: bot.login } } : {}),
      ...(mergeChecks.length > 0 ? { mergeChecks } : {}),
    },
    ok: command.ok,
    settled: command.settled ?? [],
  };
}

/**
 * Whether the review ran into the account's daily limit on gateway calls:
 * its upload is incomplete and the account has no call left. Such a review
 * is run again when the day turns, while it has attempts left.
 */
async function cutShortByDailyLimit(
  data: ReturnType<typeof scoped>,
  ref: WorkRef,
  cap: number,
  now: Date,
): Promise<boolean> {
  if (ref.kind !== "review" || ref.attempts >= MAX_ATTEMPTS) return false;
  const [own, today, job] = await Promise.all([
    data.findOne("budgets", {}),
    data.findOne("usageCounters", { kind: "gateway_calls", day: utcDay(now) }),
    data.get("reviewJobs", ref.id),
  ]);
  if (!job || (today?.n ?? 0) < Math.min(cap, own?.dailyCalls ?? cap)) return false;
  const [review] = await data.listNewest("reviews", 1, {
    prNumber: job.number,
    prHeadSha: job.head,
  });
  return review?.complete === false;
}

/**
 * Records how the job's run went and ends the session it was given: done,
 * failed with a retry later for what may pass next time, or queued again
 * for the next day when the daily limit cut its review short.
 */
export async function settle(
  { db, dailyCalls }: Pick<WorkSource, "db" | "dailyCalls">,
  ref: WorkRef,
  failure: Failure | null,
  now: Date,
): Promise<void> {
  const data = scoped(db, ref.accountId);
  const records = {
    review: {
      finish: (id: string, attempts: number, at: Date) =>
        data.autoReview.finishJob(id, attempts, null, at),
      release: data.autoReview.releaseJob,
    },
    reply: data.replies,
    generate: data.generations,
  }[ref.kind];
  if (failure === null && (await cutShortByDailyLimit(data, ref, dailyCalls, now))) {
    await data.autoReview.releaseJob(ref.id, ref.attempts, DAILY_LIMIT_WAIT, nextUtcDay(now), now);
  } else if (failure === null) {
    await records.finish(ref.id, ref.attempts, now);
  } else {
    const retry = RETRIED.has(failure) && ref.attempts < MAX_ATTEMPTS;
    logError("review_job_failed", { job: ref.id, reason: failure, retry });
    const retryAt = retry ? new Date(now.getTime() + RETRY_AFTER_MS * ref.attempts) : null;
    await records.release(ref.id, ref.attempts, failure, retryAt, now);
  }
  await data.remove("sessions", ref.id).catch(() => {});
}
