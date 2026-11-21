import { Hono } from "hono";
import { account } from "./account.js";
import { auth } from "./auth.js";
import { BodyTooLarge } from "./body.js";
import { budget } from "./budget.js";
import type { Db } from "./db/client.js";
import { device } from "./device.js";
import { exportRoute } from "./export.js";
import { gateway } from "./gateway.js";
import { apiError } from "./http.js";
import { inbox } from "./inbox.js";
import { keys } from "./keys.js";
import { errorName, logError } from "./log.js";
import { me } from "./me.js";
import { memory } from "./memory.js";
import { preferences } from "./preferences.js";
import { providersRoute } from "./providers.js";
import { repositoriesRoute } from "./repositories.js";
import { reviews } from "./reviews.js";
import { sessions } from "./sessions.js";
import type { AppBindings, AppEnv } from "./types.js";
import { usage } from "./usage.js";

/**
 * On every API answer, errors included: never read as another type, never
 * framed, no referrer, HTTPS only for a year, no powerful features and no
 * opener across origins (audit C8). The web app's own headers are in
 * web/public/_headers.
 */
export const API_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
} as const;

/**
 * The API, the same on every host: `openDb` gives each request its database
 * from the host's bindings (D1 on Workers, libSQL when self-hosted).
 */
export function createApp<E extends AppBindings>(openDb: (env: E) => Db) {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use(async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(API_HEADERS)) c.res.headers.set(name, value);
  });

  app.use(async (c, next) => {
    c.set("db", openDb(c.env as E));
    await next();
  });

  // Needs no session, so it reads nothing: on the Free plan D1's rows are a
  // daily quota shared by every account (audit C1).
  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/auth", auth);
  app.route("/device", device);

  app.route("/providers", providersRoute);

  // Every router applies its own session guard (test/routes.test.ts checks
  // each route): this file only composes them.
  app.route("/me", me);
  app.route("/usage", usage);
  app.route("/sessions", sessions);
  app.route("/export", exportRoute);
  app.route("/account", account);
  app.route("/reviews", reviews);
  app.route("/findings", inbox);
  app.route("/repositories", repositoriesRoute);
  app.route("/budget", budget);
  app.route("/preferences", preferences);
  app.route("/memory", memory);
  app.route("/keys", keys);
  app.route("/gateway", gateway);

  app.notFound((c) => apiError(c, "not_found"));
  app.onError((err, c) => {
    if (err instanceof BodyTooLarge) return apiError(c, "body_too_large");
    logError("api_error", {
      // Cloudflare's id of the request, to find it again; random elsewhere.
      requestId: c.req.header("cf-ray") ?? crypto.randomUUID(),
      method: c.req.method,
      route: c.req.routePath,
      error: errorName(err),
    });
    return apiError(c, "internal");
  });

  return app;
}
