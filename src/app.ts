import { type Context, Hono } from "hono";
import { account } from "./account.js";
import { apiTokensRoute } from "./api-tokens.js";
import { auditLog } from "./audit-log.js";
import { auth } from "./auth.js";
import { reviewNow } from "./auto-review/review-now.js";
import { type AutoReviewService, autoReviewRoute } from "./auto-review/routes.js";
import { runnerApi } from "./auto-review/runner-api.js";
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
import { healthRoute } from "./health.js";
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
import { scheduledReportsRoute } from "./notify/scheduled-report-routes.js";
import type { WebhookPost } from "./notify/webhooks.js";
import { oidc } from "./oidc.js";
import { platformConnect } from "./platform-connect.js";
import { platformLimits } from "./platform-limits.js";
import { platformsRoute } from "./platform-routes.js";
import type { BotTokens } from "./platforms/bot.js";
import { preferences } from "./preferences.js";
import { pullBatch } from "./pull-batch.js";
import { pullDescription } from "./pull-description.js";
import { pullEdits } from "./pull-edits.js";
import { pullFindings } from "./pull-findings.js";
import { pullFixes } from "./pull-fixes.js";
import { pullPage } from "./pull-page.js";
import { pullPeople } from "./pull-people.js";
import { pullSeenRoute } from "./pull-seen.js";
import { pullSince } from "./pull-since.js";
import { pullStack } from "./pull-stack.js";
import { pullThreads } from "./pull-threads.js";
import { pullViewsRoute } from "./pull-views.js";
import { releaseNotesRoute } from "./release-notes.js";
import { repoConfigRoute } from "./repo-config.js";
import { repositoriesRoute } from "./repositories.js";
import { reviewChat } from "./review-chat.js";
import { reviewLoad } from "./review-load.js";
import { atRiskRoute, reviewTargetsRoute } from "./review-targets.js";
import { reviewers } from "./reviewers.js";
import { reviews } from "./reviews.js";
import { searchRoute } from "./search.js";
import { sessions } from "./sessions.js";
import { stackMerge } from "./stack-merge/routes.js";
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
  /** Code graphs, where the host builds them (src/node/) or its remote runners do (src/graph/remote.ts). */
  graphs?: GraphService;
  /** Pull requests reviewed by the host itself (ADR-0046), where it runs them. */
  autoReview?: AutoReviewService;
  /** The GitHub App's webhook secret; without it the App's webhooks are refused. */
  githubWebhookSecret?: string;
  /** The ocra bot, which automation rules write on pull requests as; where the host has its key. */
  bots?: BotTokens;
  /** The token remote runners prove themselves with (src/auto-review/runner-api.ts); needs bots. */
  runnerToken?: string;
  /** Email, where the host sends it (SMTP on Node); without it email channels are refused. */
  mailer?: Mailer;
  /** How webhooks are posted, where the host checks more than fetch can (src/node/webhook-transport.ts). */
  webhookPost?: WebhookPost;
  /** Whether a deep health check asks that a remote runner reported in lately (src/node/). */
  runnerHeartbeat?: boolean;
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
    c.set("webhookPost", host.webhookPost);
    await next();
  });
  app.use(platformLimits);

  app.route("/health", healthRoute({ runners: host.runnerHeartbeat ?? false }));

  app.route("/auth", auth);
  app.route("/auth/oidc", oidc);
  app.route("/device", device);

  app.route("/providers", providersRoute);

  // Every router applies its own session guard (test/routes.test.ts checks
  // each route): this file only composes them.
  app.route("/me", meRoute(host.graphs?.policy ?? "off", host.autoReview !== undefined));
  app.route("/usage", usage);
  app.route("/sessions", sessions);
  app.route("/tokens", apiTokensRoute);
  app.route("/export", exportRoute);
  app.route("/account", account);
  app.route("/audit", auditLog);
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
  app.route("/pulls/merge-stack", stackMerge);
  app.route("/pulls", pullPage);
  app.route("/pulls", pullDescription);
  app.route("/pulls", pullFindings);
  app.route("/pulls", pullFixes);
  app.route("/pulls", pullBatch);
  app.route("/pulls", pullStack);
  app.route("/pulls", pullThreads);
  app.route("/pulls", pullEdits);
  app.route("/pulls", reviewers);
  app.route("/pulls", pullPeople);
  app.route("/pulls", pullReadiness);
  app.route("/pulls", reviewNow);
  app.route("/pulls", pullSeenRoute);
  app.route("/pulls", pullSince);
  app.route("/learnings", learningsRoute);
  app.route("/repo-config", repoConfigRoute);
  app.route("/release-notes", releaseNotesRoute);
  app.route("/merge-checks", mergeChecksRoute);
  app.route("/notifications", notifyRoute);
  app.route("/automations", automationsRoute);
  app.route("/scheduled-reports", scheduledReportsRoute);
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
  app.route("/insights/at-risk", atRiskRoute);
  app.route("/review-targets", reviewTargetsRoute);
  const hook = githubWebhook(host);
  app.route("/webhooks/github", hook);
  // The address the App's webhook had when it carried only pushes.
  if (host.graphs) app.route("/graphs/webhooks/github", hook);
  if (host.graphs) app.route("/graphs", graphsRoute(host.graphs));
  if (host.autoReview) app.route("/auto-review", autoReviewRoute(host.autoReview));
  if (host.runnerToken && host.bots) {
    app.route(
      "/runner",
      runnerApi({
        token: host.runnerToken,
        bots: host.bots,
        ...(host.graphs ? { graphs: host.graphs } : {}),
      }),
    );
  }

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
