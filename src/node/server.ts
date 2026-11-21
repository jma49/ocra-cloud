import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { enforceRetention } from "../db/retention.js";
import { errorName, logError } from "../log.js";
import { bindingsFrom, trustedProxyHops } from "./env.js";
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
  trustedProxyHops: trustedProxyHops(process.env.TRUSTED_PROXY_HOPS),
});

const retention = () =>
  enforceRetention(host.db).catch((err) => logError("retention_failed", { error: errorName(err) }));
setInterval(retention, DAY_MS).unref();
void retention();

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
