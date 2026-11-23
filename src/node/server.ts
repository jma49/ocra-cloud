import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { config } from "../config.js";
import { pruneGraphBuilds } from "../db/graphs.js";
import { recoverJobs } from "../db/job-recovery.js";
import { enforceRetention } from "../db/retention.js";
import { errorName, logError } from "../log.js";
import { engineGraphBuilder, engineGraphParser } from "./engine-graph.js";
import {
  autoReviewSettingsFrom,
  bindingsFrom,
  canSignIn,
  graphSettingsFrom,
  metricsTokenFrom,
  migrateMode,
  startError,
  startWarnings,
  trustedProxyHops,
  withFiles,
} from "./env.js";
import { openDatabase, openHost } from "./host.js";
import { rateLimitStore } from "./limits.js";
import { smtpMailer } from "./mailer.js";
import { installedCliVersion } from "./review-runner.js";
import { setupCode } from "./setup/code.js";
import { applyNetwork } from "./setup/network.js";
import { varsOf } from "./setup/settings.js";
import { loadSettings } from "./setup/store.js";

// The self-hosted server: `node --import tsx src/node/server.ts`, or the
// Docker image. DATABASE_URL defaults to a SQLite file in the working
// directory; PORT to 8787, as `wrangler dev`. docs/self-hosting.md lists
// every variable. The settings page's saved settings fill in what the
// environment leaves unset; saving them starts the server again in this
// process, from the database it keeps open.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// As the process started, with Docker's secret files read: what wins over a saved setting.
const ENV = withFiles(process.env, (path) => readFileSync(path, "utf8"));
// The database client reads PGPASSWORD from the environment itself.
Object.assign(process.env, ENV);
const defined = Object.fromEntries(
  Object.entries(ENV).filter((e): e is [string, string] => !!e[1]),
);
const migrate = migrateMode(ENV.MIGRATE);
const migrations = resolve(ENV.MIGRATIONS_DIR || "migrations");
const databaseUrl = ENV.DATABASE_URL || "file:ocra-cloud.db";
const database = await openDatabase(databaseUrl, {
  migrations,
  migrate: migrate !== "off",
});
if (migrate === "only") {
  database.close();
  console.log({ level: "info", event: "migrated" });
  process.exit(0);
}

type Running = { stop: () => Promise<void> };

async function start(): Promise<Running> {
  const startedAt = Date.now();
  const saved = ENV.MASTER_KEY
    ? await loadSettings(database.db, {
        current: ENV.MASTER_KEY,
        previous: ENV.MASTER_KEY_PREVIOUS,
      })
    : {};
  const vars = { ...varsOf(saved), ...defined };
  await applyNetwork(
    {
      ca: saved["network.caCertificates"],
      proxy: saved["network.httpsProxy"],
      noProxy: saved["network.noProxy"],
    },
    ENV,
    process.env,
  );
  const graphs = graphSettingsFrom(vars);
  const autoReview = autoReviewSettingsFrom(vars);
  if (autoReview && !vars.PUBLIC_URL) {
    throw new Error("auto review needs PUBLIC_URL, the address its reviews sign in to");
  }
  const metricsToken = metricsTokenFrom(vars.METRICS_TOKEN);
  const mailer = smtpMailer(vars.SMTP_URL, vars.SMTP_FROM);
  const needed = !canSignIn(vars);
  const bindings = bindingsFrom(vars, { setup: true });
  for (const event of startWarnings(bindings)) {
    // Anyone who can sign in spends the server's model key (docs/self-hosting.md, Who may sign in).
    console.warn({ level: "warn", event, set: "SIGN_IN_ALLOW" });
  }
  const host = await openHost({
    databaseUrl,
    database,
    migrations,
    rateLimits: rateLimitStore(vars.RATE_LIMITS),
    bindings,
    web: resolve(vars.WEB_DIR || "web/dist"),
    ...(vars.PUBLIC_URL ? { publicUrl: vars.PUBLIC_URL } : {}),
    trustedProxyHops: trustedProxyHops(vars.TRUSTED_PROXY_HOPS),
    ...(metricsToken
      ? { metrics: { token: metricsToken, engineVersion: installedCliVersion() } }
      : {}),
    ...(vars.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: vars.GITHUB_WEBHOOK_SECRET } : {}),
    graphs: { ...graphs, builder: engineGraphBuilder, parse: engineGraphParser },
    ...(autoReview ? { autoReview } : {}),
    ...(mailer ? { mailer } : {}),
    setup: {
      env: ENV,
      needed,
      startedAt,
      startError,
      health: {
        bindings,
        vars,
        autoReview: !!autoReview,
        runners: !!autoReview?.runnerToken,
        mailer: !!mailer,
      },
      restart,
    },
  });
  if (needed) {
    const open = vars.PUBLIC_URL ? new URL("/", vars.PUBLIC_URL).toString() : "the server";
    console.log({
      level: "info",
      event: "setup_needed",
      message: `Nobody can sign in yet: open ${open} and enter the setup code.`,
      code: await setupCode(bindings.SESSION_SECRET),
    });
  }

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, work: () => Promise<unknown>, now = false) => {
    timers.push(setInterval(work, ms).unref());
    if (now) void work();
  };
  every(
    DAY_MS,
    () =>
      Promise.all([
        enforceRetention(host.db, new Date(), config(bindings).retentionDays).catch((err) =>
          logError("retention_failed", { error: errorName(err) }),
        ),
        recoverJobs(host.db).catch((err) =>
          logError("retention_failed", { table: "jobs", error: errorName(err) }),
        ),
        pruneGraphBuilds(host.db, graphs.policy !== "off").catch((err) =>
          logError("retention_failed", { table: "graph_builds", error: errorName(err) }),
        ),
      ]),
    true,
  );
  // Hourly, so a digest goes soon after midnight UTC, a weekly report in its
  // hour and a reminder within the hour it is due, whenever the server
  // started; the database lets each go once.
  every(
    HOUR_MS,
    () => host.digests().catch((err) => logError("digest_failed", { error: errorName(err) })),
    true,
  );
  // A minute apart: the first retry of an automation's write, of a webhook
  // delivery and of a platform webhook's side effects is due a minute after
  // it failed; an armed merge-when-ready intent its webhooks left alone for a
  // quarter of an hour, and a stack merge whose webhooks did not come, are
  // read again (src/merge-when-ready/advance.ts, src/stack-merge/advance.ts).
  every(60_000, () =>
    host
      .automationRetries()
      .catch((err) => logError("automation_retry_failed", { error: errorName(err) })),
  );
  every(60_000, () =>
    host
      .deliveryRetries()
      .catch((err) => logError("delivery_retry_failed", { error: errorName(err) })),
  );
  every(60_000, () =>
    host
      .inboundRetries()
      .catch((err) => logError("inbound_retry_failed", { error: errorName(err) })),
  );
  every(60_000, () =>
    host
      .mergeIntents()
      .catch((err) => logError("merge_intent_sweep_failed", { error: errorName(err) })),
  );
  every(60_000, () =>
    host
      .stackMerges()
      .catch((err) => logError("stack_merge_sweep_failed", { error: errorName(err) })),
  );
  // Hourly: each enrolled repository is read once a UTC day, a few per run within
  // NODE_RECONCILE_CALLS platform calls (src/reconcile.ts).
  every(
    HOUR_MS,
    () =>
      Promise.all([
        host.groupSweep().catch((err) => logError("group_sweep_failed", { error: errorName(err) })),
        host.reconcile().catch((err) => logError("reconcile_failed", { error: errorName(err) })),
      ]),
    true,
  );

  const port = Number(vars.PORT || 8787);
  const server = serve({ fetch: host.fetch, port });
  console.log({ level: "info", event: "listening", port });

  return {
    stop: () =>
      new Promise<void>((done) => {
        for (const timer of timers) clearInterval(timer);
        // The work requests deferred past their answers finishes before the host closes.
        host.endStreams();
        server.close(async () => {
          await host.idle();
          host.close();
          done();
        });
        // Idle keep-alive connections would hold close() open, and a live
        // stream would for as long as it is watched: it gets five seconds.
        if ("closeIdleConnections" in server) server.closeIdleConnections();
        setTimeout(() => {
          if ("closeAllConnections" in server) server.closeAllConnections();
        }, 5_000).unref();
      }),
  };
}

let running = await start();

/** Starts again with the settings just saved; settings that would not start are refused before. */
function restart(): void {
  const previous = running;
  void previous
    .stop()
    .then(start)
    .then(
      (next) => {
        running = next;
        console.log({ level: "info", event: "restarted" });
      },
      (err: unknown) => {
        // A supervisor (Docker's restart policy) starts the process again.
        console.error({ level: "error", event: "restart_failed", error: String(err) });
        process.exit(1);
      },
    );
}

// As PID 1 in a container, Node gets no default handler for these: without
// one, `docker stop` waits out its timeout and kills the server mid-write.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void running.stop().then(() => {
      database.close();
      process.exit(0);
    });
    // A request still running gets ten seconds.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
