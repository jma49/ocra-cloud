import type { Db } from "../db/client.js";
import type { GraphBuilder } from "../graph/builder.js";
import type { GraphService } from "../graph/routes.js";
import { runNextBuild } from "../graph/runner.js";
import { errorName, logError } from "../log.js";
import type { CodePlatform } from "../platforms/platform.js";
import { platformsOf } from "../platforms/registry.js";
import type { GraphPolicy } from "../shared/index.js";
import type { AppBindings } from "../types.js";

type Options = {
  db: Db;
  env: AppBindings;
  platforms: readonly CodePlatform[];
  builder: GraphBuilder;
  /** Builds at once, each of another repository. */
  workers: number;
  /** How often it looks for due builds when nothing woke it: retries, lapsed leases. */
  pollMs?: number;
};

export type GraphOptions = {
  policy: GraphPolicy;
  builder: GraphBuilder;
  githubWebhookSecret?: string | undefined;
  workers?: number;
};

/** The graph API's service and the worker behind it; undefined when the policy is off. */
export function startGraphs(
  options: GraphOptions,
  db: Db,
  env: AppBindings,
  publicUrl: string | undefined,
): { service: GraphService; worker: ReturnType<typeof startGraphWorker> } | undefined {
  const { policy } = options;
  if (policy === "off") return undefined;
  const worker = startGraphWorker({
    db,
    env,
    // A GitLab token's refresh names this server's own address.
    platforms: platformsOf(env, publicUrl ?? "http://localhost"),
    builder: options.builder,
    workers: options.workers ?? 1,
  });
  const secret = options.githubWebhookSecret;
  return {
    service: { policy, kick: worker.kick, ...(secret ? { githubWebhookSecret: secret } : {}) },
    worker,
  };
}

/** Runs queued graph builds in this process until stopped; kick() wakes it at once. */
function startGraphWorker(options: Options) {
  const runner = {
    db: options.db,
    env: options.env,
    platforms: options.platforms,
    builder: options.builder,
  };
  let running = 0;
  let stopped = false;
  const loop = async () => {
    running++;
    try {
      while (!stopped && (await runNextBuild(runner)));
    } catch (e) {
      logError("graph_worker_failed", { error: errorName(e) });
    } finally {
      running--;
    }
  };
  const kick = () => {
    while (!stopped && running < options.workers) void loop();
  };
  const timer = setInterval(kick, options.pollMs ?? 30_000);
  // Builds queued before a restart, or by another process, start now.
  queueMicrotask(kick);
  timer.unref();
  return {
    kick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    /** Whether a build is running, for tests and shutdown. */
    busy: () => running > 0,
  };
}
