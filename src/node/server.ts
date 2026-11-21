import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { enforceRetention } from "../db/retention.js";
import { errorName, logError } from "../log.js";
import { bindingsFrom } from "./env.js";
import { openHost } from "./host.js";

// The self-hosted server: `node --import tsx src/node/server.ts`, or the
// Docker image. DATABASE_URL defaults to a SQLite file in the working
// directory; PORT to 8787, as `wrangler dev`. docs/self-hosting.md lists
// every variable.

const DAY_MS = 24 * 60 * 60 * 1000;

const host = await openHost({
  databaseUrl: process.env.DATABASE_URL || "file:ocra-cloud.db",
  bindings: bindingsFrom(process.env),
  migrations: resolve(process.env.MIGRATIONS_DIR || "migrations"),
  web: resolve(process.env.WEB_DIR || "web/dist"),
  ...(process.env.PUBLIC_URL ? { publicUrl: process.env.PUBLIC_URL } : {}),
});

const retention = () =>
  enforceRetention(host.db).catch((err) => logError("retention_failed", { error: errorName(err) }));
setInterval(retention, DAY_MS).unref();
void retention();

const port = Number(process.env.PORT || 8787);
serve({ fetch: host.fetch, port });
console.log({ level: "info", event: "listening", port });
