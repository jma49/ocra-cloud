import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";
import { createApp } from "../app.js";
import type { AutoReviewService } from "../auto-review/routes.js";
import type { Db } from "../db/client.js";
import type { AppBindings } from "../types.js";
import { clientAddress } from "./client-address.js";
import { type GraphOptions, startGraphs } from "./graph-worker.js";
import { type RateLimitStore, rateLimits } from "./limits.js";
import { openPostgres } from "./postgres.js";

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
  /** Pull requests reviewed by this server (ADR-0046); none without it. */
  autoReview?: AutoReviewService;
};

/**
 * The same API on Node: Postgres or libSQL in place of D1, the built web
 * app served from disk with the headers of its `_headers` file. Answers
 * requests with `fetch`, as the Worker does.
 */
export async function openHost(options: HostOptions) {
  const migrate = options.migrate ?? true;
  const { db: shared, close } = /^postgres(ql)?:\/\//.test(options.databaseUrl)
    ? await openPostgres(options.databaseUrl, { migrations: `${options.migrations}-pg`, migrate })
    : await openLibsql(options.databaseUrl, { migrations: options.migrations, migrate });
  const bindings =
    options.rateLimits === "database"
      ? { ...options.bindings, ...rateLimits({ db: shared }) }
      : options.bindings;
  const addresses = new WeakMap<Request, string | undefined>();
  const graphs = options.graphs && startGraphs(options.graphs, shared, bindings, options.publicUrl);
  const api = createApp({
    openDb: () => shared,
    clientAddress: (c) => addresses.get(c.req.raw),
    ...(graphs ? { graphs: graphs.service } : {}),
    ...(options.githubWebhookSecret ? { githubWebhookSecret: options.githubWebhookSecret } : {}),
    ...(options.autoReview ? { autoReview: options.autoReview } : {}),
  });

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
      return pathname === "/api" || pathname.startsWith("/api/")
        ? api.fetch(request, bindings)
        : site.fetch(request);
    },
    /** The graph build worker, when graphs are on. */
    graphWorker: graphs?.worker,
    close: () => {
      graphs?.worker.stop();
      close();
    },
  };
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
