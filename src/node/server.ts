import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { pruneGraphBuilds } from "../db/graphs.js";
import { enforceRetention } from "../db/retention.js";
import { errorName, logError } from "../log.js";
import { engineGraphBuilder, engineGraphParser } from "./engine-graph.js";
import {
  autoReviewSettingsFrom,
  bindingsFrom,
  graphSettingsFrom,
  migrateMode,
  trustedProxyHops,
} from "./env.js";
import { openHost } from "./host.js";
import { rateLimitStore } from "./limits.js";
import { smtpMailer } from "./mailer.js";

// The self-hosted server: `node --import tsx src/node/server.ts`, or the
// Docker image. DATABASE_URL defaults to a SQLite file in the working
// directory; PORT to 8787, as `wrangler dev`. docs/self-hosting.md lists
// every variable.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const graphs = graphSettingsFrom(process.env);
const autoReview = autoReviewSettingsFrom(process.env);
if (autoReview && !process.env.PUBLIC_URL) {
  throw new Error("auto review needs PUBLIC_URL, the address its reviews sign in to");
}

const mailer = smtpMailer(process.env.SMTP_URL, process.env.SMTP_FROM);
const migrate = migrateMode(process.env.MIGRATE);
const host = await openHost({
  databaseUrl: process.env.DATABASE_URL || "file:ocra-cloud.db",
  migrate: migrate !== "off",
  rateLimits: rateLimitStore(process.env.RATE_LIMITS),
  bindings: bindingsFrom(process.env),
  migrations: resolve(process.env.MIGRATIONS_DIR || "migrations"),
  web: resolve(process.env.WEB_DIR || "web/dist"),
  ...(process.env.PUBLIC_URL ? { publicUrl: process.env.PUBLIC_URL } : {}),
  trustedProxyHops: trustedProxyHops(process.env.TRUSTED_PROXY_HOPS),
  ...(process.env.GITHUB_WEBHOOK_SECRET
    ? { githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET }
    : {}),
  // A run that only migrates builds nothing.
  ...(migrate === "only"
    ? {}
    : {
        graphs: { ...graphs, builder: engineGraphBuilder, parse: engineGraphParser },
        ...(autoReview ? { autoReview } : {}),
        ...(mailer ? { mailer } : {}),
      }),
});

if (migrate === "only") {
  host.close();
  console.log({ level: "info", event: "migrated" });
  process.exit(0);
}

const retention = () =>
  Promise.all([
    enforceRetention(host.db).catch((err) =>
      logError("retention_failed", { error: errorName(err) }),
    ),
    pruneGraphBuilds(host.db, graphs.policy !== "off").catch((err) =>
      logError("retention_failed", { table: "graph_builds", error: errorName(err) }),
    ),
  ]);
setInterval(retention, DAY_MS).unref();
void retention();

// Hourly, so a digest goes soon after midnight UTC, a weekly report in its
// hour and a reminder within the hour it is due, whenever the server
// started; the database lets each go once.
const digests = () =>
  host.digests().catch((err) => logError("digest_failed", { error: errorName(err) }));
setInterval(digests, HOUR_MS).unref();
void digests();

// A minute apart: the first retry of an automation's write is due a minute after it failed.
const automationRetries = () =>
  host
    .automationRetries()
    .catch((err) => logError("automation_retry_failed", { error: errorName(err) }));
setInterval(automationRetries, 60_000).unref();

const port = Number(process.env.PORT || 8787);
const server = serve({ fetch: host.fetch, port });
console.log({ level: "info", event: "listening", port });

// As PID 1 in a container, Node gets no default handler for these: without
// one, `docker stop` waits out its timeout and kills the server mid-write.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => {
      host.close();
      process.exit(0);
    });
    // Idle keep-alive connections would hold close() open; a request still
    // running gets ten seconds.
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
