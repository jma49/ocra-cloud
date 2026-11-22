import type { AutoReviewService } from "../auto-review/routes.js";
import type { Db } from "../db/client.js";
import { errorName, logError } from "../log.js";
import { platformsOf } from "../platforms/registry.js";
import type { AppBindings } from "../types.js";
import { type BotSettings, botTokens } from "./bot-tokens.js";
import { type Exec, runNextReview } from "./review-runner.js";

export type AutoReviewOptions = {
  bots: BotSettings;
  /** Reviews at once; 0 queues them for another process sharing the database. */
  workers: number;
  exec?: Exec;
  cli?: string;
  /** How often it looks for due reviews when nothing woke it: retries, lapsed leases. */
  pollMs?: number;
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
    bots: botTokens(options.bots),
    publicUrl,
    ...(options.exec ? { exec: options.exec } : {}),
    ...(options.cli ? { cli: options.cli } : {}),
  };
  let running = 0;
  let stopped = false;
  const loop = async () => {
    running++;
    try {
      while (!stopped && (await runNextReview(runner)));
    } catch (e) {
      logError("review_worker_failed", { error: errorName(e) });
    } finally {
      running--;
    }
  };
  const kick = () => {
    while (!stopped && running < options.workers) void loop();
  };
  const timer = setInterval(kick, options.pollMs ?? 30_000);
  // Reviews queued before a restart, or by another process, start now.
  queueMicrotask(kick);
  timer.unref();
  return {
    service: { kick },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    /** Whether a review is running, for tests and shutdown. */
    busy: () => running > 0,
  };
}
