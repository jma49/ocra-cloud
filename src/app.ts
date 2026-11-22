import { type Context, Hono } from "hono";
import { account } from "./account.js";
import { auth } from "./auth.js";
import { type AutoReviewService, autoReviewRoute } from "./auto-review/routes.js";
import { BodyTooLarge } from "./body.js";
import { budget } from "./budget.js";
import { providersRoute } from "./catalog.js";
import { cycles } from "./cycles.js";
import type { Db } from "./db/client.js";
import { device } from "./device.js";
import { exportRoute } from "./export.js";
import { gateway } from "./gateway.js";
import { type GraphService, graphsRoute } from "./graph/routes.js";
import { apiError } from "./http.js";
import { inbox } from "./inbox.js";
import { keys } from "./keys.js";
import { errorName, logError } from "./log.js";
import { meRoute } from "./me.js";
import { memory } from "./memory.js";
import { notifyRoute } from "./notify/routes.js";
import { oidc } from "./oidc.js";
import { platformConnect } from "./platform-connect.js";
import { platformsRoute } from "./platform-routes.js";
import { preferences } from "./preferences.js";
import { pullPage } from "./pull-page.js";
import { pullViewsRoute } from "./pull-views.js";
import { repositoriesRoute } from "./repositories.js";
import { reviews } from "./reviews.js";
import { sessions } from "./sessions.js";
import type { AppBindings, AppEnv } from "./types.js";
import { usage } from "./usage.js";
import { githubWebhook } from "./webhooks.js";

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

/** What differs between the hosts the API runs on (src/index.ts, src/node/). */
export type Host<E extends AppBindings> = {
  /** Each request's database, from the host's bindings: D1 on Workers, libSQL self-hosted. */
  openDb: (env: E) => Db;
  /** The address the request came from, as the host's network vouches for it. */
  clientAddress: (c: Context) => string | undefined;
  /** Code graphs, where the host builds them (src/node/). */
  graphs?: GraphService;
  /** Pull requests reviewed by the host itself (ADR-0046), where it runs them. */
  autoReview?: AutoReviewService;
  /** The GitHub App's webhook secret; without it the App's webhooks are refused. */
  githubWebhookSecret?: string;
};

export function createApp<E extends AppBindings>(host: Host<E>) {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use(async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(API_HEADERS)) c.res.headers.set(name, value);
  });

  app.use(async (c, next) => {
    c.set("db", host.openDb(c.env as E));
    c.set("clientAddress", host.clientAddress(c) ?? "unknown");
    await next();
  });

  // Needs no session, so it reads nothing: on the Free plan D1's rows are a
  // daily quota shared by every account (audit C1).
  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/auth", auth);
  app.route("/auth/oidc", oidc);
  app.route("/device", device);

  app.route("/providers", providersRoute);

  // Every router applies its own session guard (test/routes.test.ts checks
  // each route): this file only composes them.
  app.route("/me", meRoute(host.graphs?.policy ?? "off"));
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
  app.route("/platforms", platformsRoute);
  app.route("/platforms", platformConnect);
  app.route("/pull-views", pullViewsRoute);
  app.route("/pulls", pullPage);
  app.route("/notifications", notifyRoute);
  app.route("/insights/cycle", cycles);
  const hook = githubWebhook(host);
  app.route("/webhooks/github", hook);
  // The address the App's webhook had when it carried only pushes.
  if (host.graphs) app.route("/graphs/webhooks/github", hook);
  if (host.graphs) app.route("/graphs", graphsRoute(host.graphs));
  if (host.autoReview) app.route("/auto-review", autoReviewRoute(host.autoReview));

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
