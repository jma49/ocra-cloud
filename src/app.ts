import { type Context, Hono } from "hono";
import { account } from "./account.js";
import { auth } from "./auth.js";
import { reviewNow } from "./auto-review/review-now.js";
import { type AutoReviewService, autoReviewRoute } from "./auto-review/routes.js";
import { automationsRoute } from "./automations/routes.js";
import { BodyTooLarge } from "./body.js";
import { budget } from "./budget.js";
import { providersRoute } from "./catalog.js";
import { cycles } from "./cycles.js";
import type { Db } from "./db/client.js";
import { device } from "./device.js";
import { exportRoute } from "./export.js";
import { findingIssues } from "./finding-issues.js";
import { flow } from "./flow.js";
import { gateway } from "./gateway.js";
import { type GraphService, graphsRoute } from "./graph/routes.js";
import { apiError } from "./http.js";
import { inbox } from "./inbox.js";
import { impact } from "./insights-impact.js";
import { keys } from "./keys.js";
import { learningsRoute } from "./learnings.js";
import { liveRoute } from "./live/routes.js";
import { errorName, logError } from "./log.js";
import { meRoute } from "./me.js";
import { memory } from "./memory.js";
import { mergeChecksRoute, pullChecksRoute } from "./merge-checks/routes.js";
import { pullReadiness } from "./merge-readiness/routes.js";
import { mergeWhenReady } from "./merge-when-ready/routes.js";
import type { Mailer } from "./notify/email.js";
import { emailLinks } from "./notify/links.js";
import { notifyRoute } from "./notify/routes.js";
import { oidc } from "./oidc.js";
import { platformConnect } from "./platform-connect.js";
import { platformsRoute } from "./platform-routes.js";
import type { BotTokens } from "./platforms/bot.js";
import { preferences } from "./preferences.js";
import { pullDescription } from "./pull-description.js";
import { pullEdits } from "./pull-edits.js";
import { pullFixes } from "./pull-fixes.js";
import { pullPage } from "./pull-page.js";
import { pullSeenRoute } from "./pull-seen.js";
import { pullStack } from "./pull-stack.js";
import { pullThreads } from "./pull-threads.js";
import { pullViewsRoute } from "./pull-views.js";
import { repoConfigRoute } from "./repo-config.js";
import { repositoriesRoute } from "./repositories.js";
import { reviewChat } from "./review-chat.js";
import { reviewLoad } from "./review-load.js";
import { reviewers } from "./reviewers.js";
import { reviews } from "./reviews.js";
import { searchRoute } from "./search.js";
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
  /** The ocra bot, which automation rules write on pull requests as; only self-hosted. */
  bots?: BotTokens;
  /** Email, where the host sends it (SMTP on Node); without it email channels are refused. */
  mailer?: Mailer;
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
    c.set("bots", host.bots);
    if (host.autoReview) c.set("autoReview", host.autoReview);
    c.set("mailer", host.mailer);
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
  app.route("/me", meRoute(host.graphs?.policy ?? "off", host.autoReview !== undefined));
  app.route("/usage", usage);
  app.route("/sessions", sessions);
  app.route("/export", exportRoute);
  app.route("/account", account);
  app.route("/reviews", reviews);
  app.route("/reviews", reviewChat);
  app.route("/live", liveRoute);
  app.route("/findings", inbox);
  app.route("/findings", findingIssues);
  app.route("/repositories", repositoriesRoute);
  app.route("/budget", budget);
  app.route("/preferences", preferences);
  app.route("/memory", memory);
  app.route("/keys", keys);
  app.route("/gateway", gateway);
  app.route("/platforms", platformsRoute);
  app.route("/platforms", platformConnect);
  app.route("/pull-views", pullViewsRoute);
  app.route("/pulls/checks", pullChecksRoute);
  app.route("/pulls/merge-when-ready", mergeWhenReady);
  app.route("/pulls", pullPage);
  app.route("/pulls", pullDescription);
  app.route("/pulls", pullFixes);
  app.route("/pulls", pullStack);
  app.route("/pulls", pullThreads);
  app.route("/pulls", pullEdits);
  app.route("/pulls", reviewers);
  app.route("/pulls", pullReadiness);
  app.route("/pulls", reviewNow);
  app.route("/pulls", pullSeenRoute);
  app.route("/learnings", learningsRoute);
  app.route("/repo-config", repoConfigRoute);
  app.route("/merge-checks", mergeChecksRoute);
  app.route("/notifications", notifyRoute);
  app.route("/automations", automationsRoute);
  app.route("/email", emailLinks);
  app.route(
    "/search",
    searchRoute({
      autoReview: host.autoReview !== undefined,
      codeGraphs: (host.graphs?.policy ?? "off") !== "off",
    }),
  );
  app.route("/insights/cycle", cycles);
  app.route("/insights/flow", flow);
  app.route("/insights/impact", impact);
  app.route("/insights/reviewers", reviewLoad);
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
