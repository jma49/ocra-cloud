import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";
import { createApp } from "../app.js";
import type { Db } from "../db/client.js";
import type { AppBindings } from "../types.js";

export type HostOptions = {
  /** A libSQL URL: `file:ocra.db` for a local SQLite file, or a libSQL server. */
  databaseUrl: string;
  bindings: AppBindings;
  /** The migrations folder (`migrations/`), applied before the first request. */
  migrations: string;
  /** The built web app (`web/dist`); without it only the API is served. */
  web?: string;
  /**
   * The address people open, as `https://ocra.example.com`, when a proxy in
   * front ends TLS: sign-in callbacks and the same-origin check read the
   * request's URL, which would otherwise be the proxy's `http://` one.
   */
  publicUrl?: string;
};

/**
 * The same API on Node: libSQL in place of D1, the built web app served
 * from disk with the headers of its `_headers` file. Answers requests with
 * `fetch`, as the Worker does.
 */
export async function openHost(options: HostOptions) {
  const client = createClient({ url: options.databaseUrl });
  // Deletes rely on foreign key cascades, which D1 enforces: said here, not
  // left to the client's default.
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: options.migrations });
  // The one place the libSQL database is taken as the type every query uses:
  // the same Drizzle SQLite API, its write results read by changedRows.
  const shared = db as unknown as Db;
  const api = createApp(() => shared);

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
    fetch(incoming: Request): Response | Promise<Response> {
      const request = origin ? new Request(rebase(incoming.url, origin), incoming) : incoming;
      const { pathname } = new URL(request.url);
      return pathname === "/api" || pathname.startsWith("/api/")
        ? api.fetch(request, options.bindings)
        : site.fetch(request);
    },
    close: () => client.close(),
  };
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
