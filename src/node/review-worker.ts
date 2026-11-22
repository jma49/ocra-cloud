import type { AutoReviewService } from "../auto-review/routes.js";
import type { Db } from "../db/client.js";
import { masterKeys } from "../keyring.js";
import { errorName, logError } from "../log.js";
import { postChecks } from "../merge-checks/publish.js";
import type { Mailer } from "../notify/email.js";
import type { BotTokens } from "../platforms/bot.js";
import { platformsOf } from "../platforms/registry.js";
import type { AppBindings } from "../types.js";
import { type BotSettings, botTokens } from "./bot-tokens.js";
import { type Exec, runNextGeneration, runNextReply, runNextReview } from "./review-runner.js";

export type AutoReviewOptions = {
  bots: BotSettings;
  /** The bot's credentials made elsewhere, in place of bots' (tests). */
  tokens?: BotTokens;
  /** Reviews at once; 0 queues them for another process sharing the database. */
  workers: number;
  exec?: Exec;
  cli?: string;
  /** How often it looks for due reviews when nothing woke it: retries, lapsed leases. */
  pollMs?: number;
  /** The server's mailer, for the email channels told of failed checks. */
  mailer?: Mailer;
};

/** Runs queued reviews in this process until stopped; kick() wakes it at once. */
export function startAutoReview(
  options: AutoReviewOptions,
  db: Db,
  env: AppBindings,
  publicUrl: string,
): { service: AutoReviewService; stop: () => void; busy: () => boolean } {
  const runner = {
    db,
    // A GitLab token's refresh names this server's own address.
    platforms: platformsOf(env, publicUrl),
    bots: options.tokens ?? botTokens(options.bots),
    publicUrl,
    outbox: {
      keys: masterKeys(env),
      mailer: options.mailer,
      linkSecret: env.SESSION_SECRET,
      origin: new URL(publicUrl).origin,
    },
    ...(options.exec ? { exec: options.exec } : {}),
    ...(options.cli ? { cli: options.cli } : {}),
  };
  let running = 0;
  let stopped = false;
  const loop = async () => {
    running++;
    try {
      while (
        !stopped &&
        ((await runNextReview(runner)) ||
          (await runNextReply(runner)) ||
          (await runNextGeneration(runner)))
      );
    } catch (e) {
      logError("review_worker_failed", { error: errorName(e) });
    } finally {
      running--;
    }
  };
  const checkPull = (accountId: string, reviewRepoId: string, number: number) => {
    postChecks(runner, accountId, reviewRepoId, number).catch((e) =>
      logError("merge_checks_failed", { repo: reviewRepoId, error: errorName(e) }),
    );
  };
  const kick = () => {
    while (!stopped && running < options.workers) void loop();
  };
  const timer = setInterval(kick, options.pollMs ?? 30_000);
  // Reviews queued before a restart, or by another process, start now.
  queueMicrotask(kick);
  timer.unref();
  return {
    service: { kick, checkPull },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    /** Whether a review is running, for tests and shutdown. */
    busy: () => running > 0,
  };
}
