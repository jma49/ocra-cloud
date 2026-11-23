import { accountSalt, loginOf, startHostedFindings } from "../db/accounts.js";
import type { Db } from "../db/client.js";
import { claimFix } from "../db/fix-jobs.js";
import { claimGenerate } from "../db/generate-jobs.js";
import { JOB_ATTEMPTS } from "../db/job-recovery.js";
import { claimLearn } from "../db/learn-jobs.js";
import { claimMend } from "../db/mend-jobs.js";
import { claimReply } from "../db/reply-jobs.js";
import { claimJob } from "../db/review-jobs.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import { findingInput } from "../findings.js";
import { reviewGraphRepo } from "../graph/review-graph.js";
import type { GraphService } from "../graph/routes.js";
import { errorName, logError } from "../log.js";
import { engineMergeChecks } from "../merge-checks/instruction.js";
import { checksOf } from "../merge-checks/run.js";
import { noteFailedJob } from "../notify/feed.js";
import type { BotAccess, BotCredential, BotTokens } from "../platforms/bot.js";
import type { CodePlatform } from "../platforms/platform.js";
import { gitlabTokenRejected, hasRepoToken } from "../platforms/repo-token.js";
import { startCliSession } from "../session.js";
import {
  type CodePlatformKind,
  DAILY_LIMIT_WAIT,
  dailyCallLimit,
  MIN_REVIEW_SPEND_USD,
  type ReviewDepth,
  spendLeftUsd,
} from "../shared/index.js";
import { spendOf } from "../spend.js";
import { nextUtcDay, utcDay } from "../time.js";
import { depthRun } from "./depths.js";
import { readHostedConfig, tightenedBy, underServer } from "./hosted-config.js";
import { mendInput } from "./mend-round.js";

// The server's half of a hosted job (ADR-0046, 4): claiming the next queued
// review, answer to an @ocra comment, request for tests or docstrings,
// round of a pull request's fix loop (./mend-work.ts),
// pull request whose declined findings become learnings, or request for a
// fix of a stored finding (./fix-work.ts), giving its run
// what it needs (the bot's credential, a CLI session of the enrolling
// account, the CLI's arguments and configuration) and recording how it went. The run itself, a clone and the released CLI, is the
// machine's half (src/node/review-runner.ts), in this process or on a
// remote runner (./runner-api.ts).

export const WORK_KINDS = ["review", "reply", "generate", "learn", "fix", "mend"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
/**
 * Kinds whose run answers in one line of JSON on stdout, which the server
 * reads with the kind's schema (./answers.ts); a runner is given one only
 * when its claim names the kind.
 */
export const ANSWERED_KINDS = ["fix", "mend"] as const satisfies readonly WorkKind[];
export type AnsweredKind = (typeof ANSWERED_KINDS)[number];

/** Why a run ended without its result; the last three are the machine's to report. */
export const RUN_FAILURES = ["clone_failed", "review_failed", "not_committed"] as const;
export type RunFailure = (typeof RUN_FAILURES)[number];
/** token_rejected: GitLab answers the project's own access token with 401, revoked or expired. */
type Failure =
  | "repo_gone"
  | "platform_gone"
  | "no_bot"
  | "token_rejected"
  | "input_gone"
  | "no_answer"
  | RunFailure;
const RETRIED: ReadonlySet<Failure> = new Set(["clone_failed", "review_failed"]);

/** A review's run, clone included; the CLI's own run timeout is shorter. */
const LEASE_MS = 45 * 60_000;
/** An answer is one model call or a few: far shorter than a review. */
const REPLY_LEASE_MS = 10 * 60_000;
/** A few model calls, one per file it writes for, and one commit. */
const GENERATE_LEASE_MS = 20 * 60_000;
/** A helper call per declined finding, and one pull request. */
const LEARN_LEASE_MS = 10 * 60_000;
/** One fixer model call, a check of what it wrote, and no commit. */
const FIX_LEASE_MS = 15 * 60_000;
/** A round's few fixer and verifier calls, a fixer task at most per finding, and one commit. */
const MEND_LEASE_MS = 30 * 60_000;
/** Declined findings drafted in one run: each is a model call of the account's. */
const MAX_LEARN_DRAFTS = 10;
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
  /**
   * The account's salt, which the CLI names the repository with. A run's
   * home is new each time: without it the CLI would make a salt per run,
   * and every review would count as another repository.
   */
  uploadSalt: string;
  /** The CLI's arguments, before the path of its configuration file. */
  args: string[];
  config: Record<string, unknown>;
  /** Exit codes that mean done, and those that end the job without a retry. */
  ok: number[];
  settled: number[];
  /**
   * A review of a repository the account keeps a code graph of: the run
   * reads that graph and answers what the pull request reaches in it.
   */
  graph?: { repoId: string; pull: number };
  /**
   * An answered kind's run: `input`, when given, is written to a file the
   * CLI is given with `flag`, as each of `more` is, and the last line the
   * CLI prints is the answer.
   */
  answered?: AnsweredRun;
};

export type AnsweredRun = {
  flag?: string;
  input?: unknown;
  more?: { flag: string; input: unknown }[];
};

export type WorkSource = {
  db: Db;
  platforms: readonly CodePlatform[];
  bots: BotTokens;
  /** This server's own address, which the CLI signs in to. */
  publicUrl: string;
  /** The service's daily cap on an account's gateway calls: an account at it waits. */
  dailyCalls: number;
  /** Code graphs, where the host keeps them and the machine that runs the job reads them. */
  graphs?: GraphService;
  /** A review's lease, when not the default. */
  leaseMs?: number;
  now?: () => Date;
};

type Claimed = {
  id: string;
  accountId: string;
  reviewRepoId: string;
  number: number;
  /** A review's own depth, chosen when a person asked for it. */
  depth?: ReviewDepth | null;
};
type Command = {
  args: (pull: string[], repo: Row<"reviewRepos">) => string[];
  ok: number[];
  settled?: number[];
  access?: BotAccess;
  mergeChecks?: true;
  /**
   * Whether the review's depth (src/shared/review-depths.ts), else its repository's,
   * and the settings of its default branch's .ocra/config.json (./hosted-config.ts) apply.
   */
  depth?: true;
  /** An answered kind's input (Assignment's `answered`); undefined when what it needs is gone. */
  answered?: (data: Scoped) => Promise<AnsweredRun | undefined>;
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
          depth: true,
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
  if (kind === "generate") {
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
  if (kind === "fix") {
    const claimed = await claimFix(source.db, now, FIX_LEASE_MS, source.dailyCalls);
    return (
      claimed && {
        claimed,
        command: {
          // Read-only: `ocra fix` writes nothing to the repository; the answer is its stdout.
          args: (pull) => ["fix", ...pull, "--head", claimed.head, "--json"],
          // 3: the finding's code is gone at the head, or the head moved; the answer says which.
          ok: [0, 3],
          answered: async (data) => {
            const finding = await data.get("findings", claimed.findingId);
            return finding && { flag: "--finding", input: findingInput(finding) };
          },
        },
      }
    );
  }
  if (kind === "mend") {
    const claimed = await claimMend(source.db, now, MEND_LEASE_MS, source.dailyCalls);
    return (
      claimed && {
        claimed,
        command: {
          // A round of the pull request's fix loop (./mend-round.ts gives it its input).
          args: (pull) => ["mend", ...pull, "--level", "commit", "--json"],
          // 3: the head moved under the round, or the bot cannot write to the branch; the answer says which.
          ok: [0, 3],
          access: "commit",
        },
      }
    );
  }
  const claimed = await claimLearn(source.db, now, LEARN_LEASE_MS, source.dailyCalls);
  return (
    claimed && {
      claimed,
      command: {
        // The learnings are opened as the bot's pull request, which merges
        // once its checks pass unless the repository leaves that to a person.
        args: (pull, repo) => [
          "learn",
          "feedback",
          ...pull,
          "--propose",
          "--max",
          String(MAX_LEARN_DRAFTS),
          ...(repo.learn === "propose" ? ["--require-review"] : []),
        ],
        ok: [0],
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
  const bot = platform && (await source.bots.forRepo(repo, command.access));
  if (!repo || !platform || !bot) {
    await settle(source, ref, !repo ? "repo_gone" : !platform ? "platform_gone" : "no_bot", now());
    return "refused";
  }
  const mend = kind === "mend" ? await mendInput(data, claimed.id, repo) : undefined;
  if (typeof mend === "string") {
    await data.mends.skip(claimed.id, claimed.attempts, mend, now());
    return "refused";
  }
  const answered = mend ?? (command.answered && (await command.answered(data)));
  if (command.answered && !answered) {
    await settle(source, ref, "input_gone", now());
    return "refused";
  }
  // Switched off since it was queued: nothing is read.
  if (kind === "learn" && repo.learn === "off") {
    await settle(source, ref, null, now());
    return "refused";
  }
  // A token GitLab no longer takes fails each job at once, rather than a clone retried.
  if (
    repo.platform === "gitlab" &&
    hasRepoToken(repo) &&
    (await gitlabTokenRejected(platform.url, bot.token))
  ) {
    await settle(source, ref, "token_rejected", now());
    return "refused";
  }
  const mergeChecks = command.mergeChecks
    ? await engineMergeChecks(await checksOf(data, repo.id))
    : [];
  const repoFile = command.depth
    ? await readHostedConfig(platform, bot.token, repo.fullName)
    : { config: {}, ignored: false };
  const saved = await data.findOne("preferences", {});
  const {
    repo: repoConfig,
    depth,
    refused,
  } = tightenedBy(
    repoFile.config,
    command.depth ? depthRun(claimed.depth ?? repo.reviewDepth) : { config: {}, flags: [] },
    saved?.settings ?? undefined,
  );
  if (repoFile.ignored || refused) await data.autoReview.noteJob(claimed.id, claimed.attempts);
  // The CLI's own default is OpenCode, which waits out a refused call where
  // Direct stops at once; the account's saved runtime, below this file, wins.
  const runtime = saved?.runtime ? {} : { runtime: "direct" as const };
  const maxCostUsd =
    kind === "review" || kind === "fix" || kind === "mend"
      ? await reviewSpendCap(data, saved?.settings?.maxCostUsd, now())
      : undefined;
  const pull =
    platform.kind === "github"
      ? ["--pr", String(claimed.number), "--repo", repo.fullName]
      : ["--mr", String(claimed.number), "--project", repo.fullName];
  // The account's first hosted run starts keeping its findings; a choice it made stands.
  await startHostedFindings(source.db, claimed.accountId);
  // A run that died left its session behind: this attempt's replaces it.
  await data.remove("sessions", claimed.id);
  const tokens = await startCliSession(source.db, claimed.accountId, "auto review", claimed.id);
  // A review runs without a graph when its repository's cannot be found or added.
  const graphRepoId =
    source.graphs && kind === "review"
      ? await reviewGraphRepo(source.graphs, data, platform, repo, bot).catch((e) => {
          logError("review_graph_repo_failed", { job: claimed.id, error: errorName(e) });
          return undefined;
        })
      : undefined;
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
    uploadSalt: await accountSalt(source.db, claimed.accountId),
    args: [...command.args(pull, repo), ...depth.flags],
    config: underServer(repoConfig, {
      ...runtime,
      ...depth.config,
      ...(bot.login ? { github: { botLogin: bot.login } } : {}),
      ...(mergeChecks.length > 0 ? { mergeChecks } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    }),
    ok: command.ok,
    settled: command.settled ?? [],
    ...(graphRepoId ? { graph: { repoId: graphRepoId, pull: claimed.number } } : {}),
    ...(answered ? { answered } : {}),
  };
}

/**
 * What a hosted review may spend: what is left before the account's nearer
 * spend limit, or its own limit per review where that is less; none with
 * both spend limits off and no limit per review. The run's
 * configuration file replaces the account's settings key by key, so the
 * account's limit is read here rather than left to the CLI.
 */
async function reviewSpendCap(
  data: ReturnType<typeof scoped>,
  own: number | undefined,
  now: Date,
): Promise<number | undefined> {
  const left = Math.max(MIN_REVIEW_SPEND_USD, spendLeftUsd(await spendOf(data, now)));
  const cap = Math.min(left, own ?? left);
  return Number.isFinite(cap) ? Math.round(cap * 100) / 100 : undefined;
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
  if (ref.kind !== "review" || ref.attempts >= JOB_ATTEMPTS) return false;
  const [own, today, job] = await Promise.all([
    data.findOne("budgets", {}),
    data.findOne("usageCounters", { kind: "gateway_calls", day: utcDay(now) }),
    data.get("reviewJobs", ref.id),
  ]);
  if (!job || (today?.n ?? 0) < dailyCallLimit(own?.dailyCalls, cap)) return false;
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
    learn: data.learning,
    // A fix's answer is recorded by ./answers.ts: a run settled here without one has none.
    fix: {
      finish: (id: string, attempts: number, at: Date) =>
        data.fixes.release(id, attempts, "no_answer", null, at),
      release: data.fixes.release,
    },
    mend: {
      finish: (id: string, attempts: number, at: Date) =>
        data.mends.release(id, attempts, "no_answer", null, at),
      release: data.mends.release,
    },
  }[ref.kind];
  // A run the limit stopped before any task finished exits as failed: the limit is still why.
  const limited =
    (failure === null || failure === "review_failed") &&
    (await cutShortByDailyLimit(data, ref, dailyCalls, now));
  if (limited) {
    await data.autoReview.releaseJob(ref.id, ref.attempts, DAILY_LIMIT_WAIT, nextUtcDay(now), now);
  } else if (failure === null) {
    await records.finish(ref.id, ref.attempts, now);
  } else {
    const retry = RETRIED.has(failure) && ref.attempts < JOB_ATTEMPTS;
    logError("review_job_failed", { job: ref.id, reason: failure, retry });
    const retryAt = retry ? new Date(now.getTime() + RETRY_AFTER_MS * ref.attempts) : null;
    await records.release(ref.id, ref.attempts, failure, retryAt, now);
    if (!retry) await noteFailedJob(data, ref.kind, ref.id, now);
  }
  await data.remove("sessions", ref.id).catch(() => {});
}
