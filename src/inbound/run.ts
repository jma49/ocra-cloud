import { keepReviewedPaths, type PathReader } from "../auto-review/paths.js";
import type { Db } from "../db/client.js";
import {
  type ClaimedInbound,
  claimInboundRetry,
  finishInbound,
  type InboundOutcome,
} from "../db/inbound-events.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { masterKeys } from "../keyring.js";
import { errorName, logError } from "../log.js";
import type { MergeRunner } from "../merge-when-ready/advance.js";
import { moveGithubIntents, moveIntents, type PullSignal } from "../merge-when-ready/hooks.js";
import type { Mailer } from "../notify/email.js";
import { gitlabStartOf } from "../notify/gitlab-starts.js";
import type { Outbox } from "../notify/notify.js";
import { tellGithubHook, tellGitlabHook, tellGitlabNote } from "../notify/pull-hooks.js";
import type { WebhookPost } from "../notify/webhooks.js";
import type { BotTokens } from "../platforms/bot.js";
import { platformsOf } from "../platforms/registry.js";
import type { AppBindings } from "../types.js";

// A delivery's side effects after its answer: telling the account's
// channels, moving merge-when-ready intents and reading a reviewed pull
// request's directories. Each is safe to run again (the notices' keys, the
// intents' compare-and-set, the paths' head), so a step that throws is
// tried again with backoff, by the sweep, until MAX_ATTEMPTS; the steps
// that succeeded are not. A restart mid-way leaves the row pending, and the
// sweep takes it once its lease is over.

export type InboundStep = "tell" | "intents" | "paths";

/** What a delivery's side effects still need: never its whole body (./fields.ts). */
export type InboundWork = {
  /** The console's origin, which the notices link to. */
  origin: string;
  steps: InboundStep[];
  body?: Record<string, unknown>;
  /** The pull request whose kept review asks for its directories. */
  reviewed?: { number: number; head?: string | undefined };
  /** GitLab's: the signal, already read, for the proved project's intents. */
  signal?: { fullName: string; signal: PullSignal };
};

/** What a host gives the side effects, in a request or in its sweep. */
export type InboundRunner = {
  db: Db;
  env: AppBindings;
  bots: BotTokens | undefined;
  mailer?: Mailer | undefined;
  webhookPost?: WebhookPost | undefined;
};

/** Attempts in all, the first included. */
export const MAX_INBOUND_ATTEMPTS = 4;
/** How long after a failed attempt (the first, second, third) the next one is due. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
/** How long an attempt is held: past it, after a restart, the sweep takes it. */
export const INBOUND_LEASE_MS = 10 * 60_000;
/** Attempts one sweep makes at most. */
const PER_SWEEP = 50;

function means(runner: InboundRunner, origin: string) {
  const out: Outbox = {
    keys: masterKeys(runner.env),
    mailer: runner.mailer,
    linkSecret: runner.env.SESSION_SECRET,
    origin,
    webhooks: runner.webhookPost,
  };
  const platforms = platformsOf(runner.env, origin);
  const reader: PathReader = { db: runner.db, bots: runner.bots, platforms, env: runner.env };
  const merges: MergeRunner = { db: runner.db, env: runner.env, platforms, out };
  return { out, reader, merges };
}

async function runStep(
  runner: InboundRunner,
  row: ClaimedInbound,
  work: InboundWork,
  step: InboundStep,
): Promise<void> {
  const { db } = runner;
  const { out, reader, merges } = means(runner, work.origin);
  const body = work.body ?? {};
  if (row.platform === "github" && step === "tell") {
    await tellGithubHook(db, row.host, out, row.event, body);
    return;
  }
  if (row.platform === "github" && step === "intents") {
    await moveGithubIntents(merges, row.host, row.event, body);
    return;
  }
  // The repository is read again: it may have been removed since.
  const repo = await reviewRepoFor(db, row.platform, row.host, row.repo);
  if (!repo) return;
  if (step === "paths") {
    const pull = work.reviewed;
    if (pull) await keepReviewedPaths(reader, { repo, number: pull.number, head: pull.head });
  } else if (step === "intents") {
    if (work.signal) await moveIntents(merges, repo, work.signal.fullName, work.signal.signal);
  } else if (row.event === "Note Hook") {
    await tellGitlabNote(db, out, repo, body, gitlabStartOf(reader, repo));
  } else {
    await tellGitlabHook(db, out, repo, body);
  }
}

/** Runs the attempt's steps and records how it went; the steps left. */
export async function runInbound(
  runner: InboundRunner,
  row: ClaimedInbound,
  now = () => new Date(),
): Promise<InboundStep[]> {
  const work = row.work as InboundWork | null;
  if (!work) {
    await finishInbound(runner.db, row.id, row.attempts, { state: "failed" });
    return [];
  }
  const failed: InboundStep[] = [];
  for (const step of work.steps) {
    try {
      await runStep(runner, row, work, step);
    } catch (e) {
      failed.push(step);
      // Only our own words: an error's text could quote the delivery.
      logError("inbound_step_failed", {
        platform: row.platform,
        event: row.event,
        step,
        attempts: row.attempts,
        error: errorName(e),
      });
    }
  }
  const delay = RETRY_DELAYS_MS[row.attempts - 1];
  const outcome: InboundOutcome =
    failed.length === 0
      ? { state: "done" }
      : row.attempts < MAX_INBOUND_ATTEMPTS && delay !== undefined
        ? {
            state: "pending",
            work: { ...work, steps: failed },
            retryAt: new Date(now().getTime() + delay),
          }
        : { state: "failed" };
  await finishInbound(runner.db, row.id, row.attempts, outcome);
  return failed;
}

/**
 * Tries the deliveries due again; how many it tried. It goes round the
 * repositories, one delivery each in turn, so that one busy or failing
 * repository cannot take a whole sweep from every other account's.
 */
export async function retryInbound(runner: InboundRunner, now = () => new Date()) {
  let tried = 0;
  const round = new Set<string>();
  for (; tried < PER_SWEEP; tried++) {
    let due = await claimInboundRetry(runner.db, now(), INBOUND_LEASE_MS, [...round]);
    if (!due && round.size > 0) {
      round.clear();
      due = await claimInboundRetry(runner.db, now(), INBOUND_LEASE_MS);
    }
    if (!due) break;
    round.add(due.repo);
    await runInbound(runner, due, now);
  }
  return tried;
}
