import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { type ExecutionContext, Hono } from "hono";
import { createApp } from "../app.js";
import { retryAutomations } from "../automations/retry.js";
import { CallBudget } from "../calls.js";
import type { Db } from "../db/client.js";
import { retryInbound } from "../inbound/run.js";
import { masterKeys } from "../keyring.js";
import { sweepMergeIntents } from "../merge-when-ready/advance.js";
import { runAtRisk } from "../notify/at-risk.js";
import { runDigests } from "../notify/digest.js";
import type { Mailer } from "../notify/email.js";
import { runHeld } from "../notify/held.js";
import { retryNotifications } from "../notify/notify.js";
import { runReminders } from "../notify/reminders.js";
import { runReports } from "../notify/report.js";
import type { WebhookPost } from "../notify/webhooks.js";
import { botTokens } from "../platforms/bot-tokens.js";
import { githubHostOf, platformsOf } from "../platforms/registry.js";
import { NODE_RECONCILE_CALLS, reconcileRepos } from "../reconcile.js";
import { sweepStackMerges } from "../stack-merge/advance.js";
import type { AppBindings } from "../types.js";
import { clientAddress } from "./client-address.js";
import { type GraphOptions, startGraphs } from "./graph-worker.js";
import { type RateLimitStore, rateLimits } from "./limits.js";
import { type MetricsOptions, metricsEndpoint } from "./metrics.js";
import { openPostgres } from "./postgres.js";
import { type AutoReviewOptions, startAutoReview } from "./review-worker.js";
import { nodeWebhookPost } from "./webhook-transport.js";

export type HostOptions = {
  /**
   * A Postgres server (`postgres://…`), or a libSQL URL: `file:ocra.db` for
   * a local SQLite file, or a libSQL server.
   */
  databaseUrl: string;
  bindings: AppBindings;
  /**
   * The migrations folder (`migrations/`), applied before the first request;
   * a Postgres database takes those of the folder beside it (`migrations-pg/`).
   */
  migrations: string;
  /** The built web app (`web/dist`); without it only the API is served. */
  web?: string;
  /**
   * The address people open, as `https://ocra.example.com`, when a proxy in
   * front ends TLS: sign-in callbacks and the same-origin check read the
   * request's URL, which would otherwise be the proxy's `http://` one.
   */
  publicUrl?: string;
  /**
   * How many proxies in front append to X-Forwarded-For, so that the client's
   * address, which the login code limits count by, is read past them. 0 reads
   * the socket's peer.
   */
  trustedProxyHops?: number;
  /** Where the rate limits count: memory (one process) or the database (several sharing it). */
  rateLimits?: RateLimitStore;
  /**
   * Whether this process applies the migrations at start: on by default.
   * Several processes sharing a database leave it to one run (MIGRATE=only).
   */
  migrate?: boolean;
  /** Code graphs built after pushes, by the engine's builder; none when policy is off. */
  graphs?: GraphOptions;
  /** The GitHub App's webhook secret; without it the App's webhooks are refused. */
  githubWebhookSecret?: string;
  /** Pull requests reviewed by this server (ADR-0046); none without it. Needs publicUrl. */
  autoReview?: AutoReviewOptions;
  /** Email notifications and digests (SMTP_URL); none without it. */
  mailer?: Mailer;
  /** How webhooks are posted; nodeWebhookPost() unless a test gives its own. */
  webhookPost?: WebhookPost;
  /** GET /metrics (METRICS_TOKEN); answered 404 without it. */
  metrics?: Omit<MetricsOptions, "startedAt">;
};

/**
 * The same API on Node: Postgres or libSQL in place of D1, the built web
 * app served from disk with the headers of its `_headers` file. Answers
 * requests with `fetch`, as the Worker does.
 */
export async function openHost(options: HostOptions) {
  const startedAt = Date.now();
  const migrate = options.migrate ?? true;
  const { db: shared, close } = await openDatabase(options.databaseUrl, {
    migrations: options.migrations,
    migrate,
  });
  const bindings =
    options.rateLimits === "database"
      ? { ...options.bindings, ...rateLimits({ db: shared }) }
      : options.bindings;
  const addresses = new WeakMap<Request, string | undefined>();
  const webhookPost = options.webhookPost ?? nodeWebhookPost();
  const graphs = options.graphs && startGraphs(options.graphs, shared, bindings, options.publicUrl);
  const reviews =
    options.autoReview && options.publicUrl
      ? startAutoReview(
          {
            ...options.autoReview,
            ...(options.mailer ? { mailer: options.mailer } : {}),
            webhookPost,
          },
          shared,
          bindings,
          options.publicUrl,
          graphs?.service,
        )
      : undefined;
  const bots = options.autoReview
    ? (options.autoReview.tokens ?? botTokens(options.autoReview.bots))
    : undefined;
  const api = createApp({
    openDb: () => shared,
    clientAddress: (c) => addresses.get(c.req.raw),
    ...(graphs ? { graphs: graphs.service } : {}),
    ...(options.githubWebhookSecret ? { githubWebhookSecret: options.githubWebhookSecret } : {}),
    ...(reviews ? { autoReview: reviews.service } : {}),
    ...(bots ? { bots } : {}),
    ...(options.autoReview?.runnerToken ? { runnerToken: options.autoReview.runnerToken } : {}),
    ...(options.mailer ? { mailer: options.mailer } : {}),
    webhookPost,
    runnerHeartbeat: !!options.autoReview?.runnerToken,
  });
  const metrics = options.metrics && metricsEndpoint(shared, { ...options.metrics, startedAt });
  const deferred = new Set<Promise<unknown>>();
  const executionCtx: ExecutionContext = {
    waitUntil(work) {
      deferred.add(work);
      const done = () => deferred.delete(work);
      work.then(done, done);
    },
    passThroughOnException() {},
    props: {},
  };

  const origin = options.publicUrl ? new URL(options.publicUrl).origin : undefined;
  const site = new Hono();
  if (options.web) {
    const root = options.web;
    const headers = parseHeaders(await readFile(join(root, "_headers"), "utf8").catch(() => ""));
    site.use(async (c, next) => {
      await next();
      for (const [name, value] of headers) c.res.headers.set(name, value);
    });
    site.use("/*", serveStatic({ root }));
    site.get("*", serveStatic({ root, path: "index.html" }));
  }

  return {
    db: shared,
    /** As `serve` calls it: the request, and the Node request it came on. */
    fetch(
      incoming: Request,
      node?: { incoming: { socket: { remoteAddress?: string | undefined } } },
    ): Response | Promise<Response> {
      const request = origin ? new Request(rebase(incoming.url, origin), incoming) : incoming;
      addresses.set(
        request,
        clientAddress(
          node?.incoming.socket.remoteAddress,
          request.headers.get("x-forwarded-for"),
          options.trustedProxyHops ?? 0,
        ),
      );
      const { pathname } = new URL(request.url);
      if (pathname === "/metrics") {
        return metrics ? metrics(request) : new Response("not found\n", { status: 404 });
      }
      return pathname === "/api" || pathname.startsWith("/api/")
        ? api.fetch(request, bindings, executionCtx)
        : site.fetch(request);
    },
    /**
     * Sends the daily digests, weekly reports, review reminders, quiet
     * hours' held notices and pull requests at risk not sent yet; needs
     * publicUrl, which their links point to.
     */
    digests: async () => {
      if (!origin) return;
      const out = {
        keys: masterKeys(bindings),
        mailer: options.mailer,
        linkSecret: bindings.SESSION_SECRET,
        slack: bindings.SLACK_BOT_TOKEN,
        origin,
        webhooks: webhookPost,
      };
      await Promise.all([
        runDigests(shared, out),
        runReports(shared, out),
        runReminders(shared, out, githubHostOf(bindings).host),
        runHeld(shared, out),
        runAtRisk(shared, out),
      ]);
    },
    /** Tries again the automations' writes the platform did not answer; only with a bot. */
    automationRetries: async () => {
      if (!bots || !options.publicUrl) return 0;
      const platforms = platformsOf(bindings, options.publicUrl);
      return retryAutomations({ db: shared, bots, platforms });
    },
    /** Reads again the merge-when-ready intents their webhooks left armed; how many it tried. */
    mergeIntents: () =>
      sweepMergeIntents({
        db: shared,
        env: bindings,
        platforms: platformsOf(bindings, options.publicUrl ?? "http://localhost"),
        out: {
          keys: masterKeys(bindings),
          mailer: options.mailer,
          linkSecret: bindings.SESSION_SECRET,
          slack: bindings.SLACK_BOT_TOKEN,
          origin: origin ?? "http://localhost",
          webhooks: webhookPost,
        },
      }),
    /** Moves on the stack merges left waiting; how many it tried. */
    stackMerges: () =>
      sweepStackMerges({
        db: shared,
        env: bindings,
        platforms: platformsOf(bindings, options.publicUrl ?? "http://localhost"),
        // How a merge ended is told with links under publicUrl.
        out: origin
          ? {
              keys: masterKeys(bindings),
              mailer: options.mailer,
              linkSecret: bindings.SESSION_SECRET,
              slack: bindings.SLACK_BOT_TOKEN,
              origin,
              webhooks: webhookPost,
            }
          : undefined,
      }),
    /** Reads the enrolled repositories due their daily reconciliation; how many it claimed. */
    reconcile: () =>
      reconcileRepos({
        db: shared,
        env: bindings,
        platforms: platformsOf(bindings, options.publicUrl ?? "http://localhost"),
        bots,
        calls: new CallBudget(NODE_RECONCILE_CALLS),
      }),
    /** Tries again the channels' deliveries due, of every kind; how many it tried. */
    deliveryRetries: () =>
      retryNotifications(shared, {
        keys: masterKeys(bindings),
        mailer: options.mailer,
        webhooks: webhookPost,
        slack: bindings.SLACK_BOT_TOKEN,
      }),
    /** Runs again the side effects of platform webhooks that failed and are due; how many it tried. */
    inboundRetries: () =>
      retryInbound({
        db: shared,
        env: bindings,
        bots,
        mailer: options.mailer,
        webhookPost,
      }),
    /** The graph build worker, when graphs are on. */
    graphWorker: graphs?.worker,
    /** The review worker, when auto review is on. */
    reviewWorker: reviews,
    /** Resolves once the work answered requests deferred has finished, the database still open. */
    idle: async () => {
      while (deferred.size > 0) await Promise.allSettled(deferred);
    },
    close: () => {
      graphs?.worker.stop();
      reviews?.stop();
      close();
    },
  };
}

/**
 * DATABASE_URL's database: Postgres, with the migrations of the folder
 * beside `migrations` (`migrations-pg/`), or libSQL with `migrations`.
 */
export function openDatabase(url: string, options: { migrations: string; migrate: boolean }) {
  return /^postgres(ql)?:\/\//.test(url)
    ? openPostgres(url, { ...options, migrations: `${options.migrations}-pg` })
    : openLibsql(url, options);
}

async function openLibsql(url: string, options: { migrations: string; migrate: boolean }) {
  const client = createClient({ url });
  // Deletes rely on foreign key cascades, which D1 enforces: said here, not
  // left to the client's default.
  await client.execute("PRAGMA foreign_keys = ON");
  if (url.startsWith("file:")) {
    // Several processes may share the file (several replicas on one
    // machine): readers do not block the writer, and a writer waits for
    // another's lock instead of failing at once.
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
  }
  const db = drizzle(client);
  if (options.migrate) await migrate(db, { migrationsFolder: options.migrations });
  // The one place the libSQL database is taken as the type every query uses:
  // the same Drizzle SQLite API, its write results read by changedRows.
  return { db: db as unknown as Db, close: () => client.close() };
}

function rebase(url: string, origin: string): string {
  const u = new URL(url);
  return origin + u.pathname + u.search;
}

/** The headers of a `_headers` file's `/*` block. */
export function parseHeaders(text: string): [string, string][] {
  const out: [string, string][] = [];
  let inAll = false;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inAll = line.trim() === "/*";
      continue;
    }
    const at = line.indexOf(":");
    if (inAll && at > 0) out.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return out;
}
