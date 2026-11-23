import type { AutoReviewService } from "../auto-review/routes.js";
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { scoped } from "../db/scoped.js";
import { gunzip } from "../graph/gzip.js";
import type { GraphService } from "../graph/routes.js";
import { masterKeys } from "../keyring.js";
import { errorName, logError } from "../log.js";
import { postChecks } from "../merge-checks/publish.js";
import type { Mailer } from "../notify/email.js";
import type { WebhookPost } from "../notify/webhooks.js";
import type { BotTokens } from "../platforms/bot.js";
import { type BotSettings, botTokens } from "../platforms/bot-tokens.js";
import { platformsOf } from "../platforms/registry.js";
import type { AppBindings } from "../types.js";
import type { Exec } from "./checkout.js";
import {
  runNextGeneration,
  runNextLearning,
  runNextReply,
  runNextReview,
} from "./review-runner.js";

export type AutoReviewOptions = {
  bots: BotSettings;
  /** The bot's credentials made elsewhere, in place of bots' (tests). */
  tokens?: BotTokens;
  /** Reviews at once; 0 queues them for another process sharing the database. */
  workers: number;
  /** What remote runners prove themselves with; none take jobs without it. */
  runnerToken?: string;
  exec?: Exec;
  cli?: string;
  /** How often it looks for due reviews when nothing woke it: retries, lapsed leases. */
  pollMs?: number;
  /** The server's mailer, for the email channels told of failed checks. */
  mailer?: Mailer;
  /** How the webhook channels told of failed checks are posted. */
  webhookPost?: WebhookPost;
};

/** Runs queued reviews in this process until stopped; kick() wakes it at once. */
export function startAutoReview(
  options: AutoReviewOptions,
  db: Db,
  env: AppBindings,
  publicUrl: string,
  graphs?: GraphService,
): { service: AutoReviewService; stop: () => void; busy: () => boolean } {
  const runner = {
    db,
    // A GitLab token's refresh names this server's own address.
    platforms: platformsOf(env, publicUrl),
    bots: options.tokens ?? botTokens(options.bots),
    publicUrl,
    dailyCalls: config(env).gatewayDailyCalls,
    outbox: {
      keys: masterKeys(env),
      mailer: options.mailer,
      webhooks: options.webhookPost,
      linkSecret: env.SESSION_SECRET,
      origin: new URL(publicUrl).origin,
    },
    ...(options.exec ? { exec: options.exec } : {}),
    ...(options.cli ? { cli: options.cli } : {}),
    // A review reads the graph this server keeps of its repository.
    ...(graphs
      ? {
          graphs,
          keptGraphs: {
            newest: async (accountId: string, repoId: string) => {
              const kept = await scoped(db, accountId).graphs.newestGraph(repoId);
              return kept && gunzip(kept.content);
            },
          },
        }
      : {}),
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
          (await runNextGeneration(runner)) ||
          (await runNextLearning(runner)))
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
    service: {
      kick,
      checkPull,
      ...(options.bots.githubAppId ? { githubAppId: options.bots.githubAppId } : {}),
      ...(options.runnerToken ? { remote: true as const } : {}),
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    /** Whether a review is running, for tests and shutdown. */
    busy: () => running > 0,
  };
}
