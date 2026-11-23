import { inspectRoutes } from "hono/dev";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index.js";
import { API_TOKEN_ROUTES, API_TOKEN_SCOPES } from "../src/shared/index.js";
import { call, resetDb, signIn, signInCli, signInToken } from "./helpers.js";

// Every route the app serves, and which sessions reach it. A route added
// without a line here fails the first test; a route whose router lost its
// guard answers an unauthenticated request with something other than 401
// (usually a 500, reading a session that is not there) and fails the second.

type Access = "public" | "web" | "cli" | "web+cli";

const ACCESS: Record<string, Access> = {
  "GET /api/health": "public",
  "POST /api/webhooks/github": "public",
  "GET /api/providers": "public",
  "GET /api/auth/github/login": "public",
  "GET /api/auth/github/callback": "public",
  "GET /api/auth/methods": "public",
  "GET /api/auth/oidc/login": "public",
  "GET /api/auth/oidc/callback": "public",
  "POST /api/auth/logout": "web+cli",
  "POST /api/device/code": "public",
  "GET /api/device/info": "web",
  "POST /api/device/decide": "web",
  "POST /api/device/token": "public",
  "POST /api/device/refresh": "public",
  "GET /api/me": "web+cli",
  "GET /api/usage": "web",
  "GET /api/sessions": "web",
  "DELETE /api/sessions/:id": "web",
  "GET /api/tokens": "web",
  "POST /api/tokens": "web",
  "DELETE /api/tokens/:id": "web",
  "GET /api/export": "web",
  "GET /api/findings": "web",
  "GET /api/budget": "web",
  "GET /api/platforms/pulls": "web",
  "GET /api/search": "web",
  "GET /api/pull-views": "web",
  "POST /api/pull-views": "web",
  "POST /api/pull-views/defaults": "web",
  "PUT /api/pull-views/order": "web",
  "PUT /api/pull-views/:id": "web",
  "DELETE /api/pull-views/:id": "web",
  "GET /api/pulls/files": "web",
  "GET /api/pulls/since": "web",
  "POST /api/pulls/comment": "web",
  "POST /api/pulls/review": "web",
  "POST /api/pulls/merge": "web",
  "POST /api/pulls/viewed": "web",
  "GET /api/pulls/queue": "web",
  "POST /api/pulls/enqueue": "web",
  "POST /api/pulls/dequeue": "web",
  "POST /api/pulls/apply-fix": "web",
  "GET /api/pulls/description-draft": "web",
  "GET /api/pulls/fixes": "web",
  "GET /api/pulls/fixes/review/:id": "web",
  "POST /api/pulls/description": "web",
  "GET /api/findings/:id/issue-draft": "web",
  "POST /api/findings/:id/issue": "web",
  "GET /api/pulls/threads": "web",
  "POST /api/pulls/apply-suggestions": "web",
  "POST /api/pulls/resolve-thread": "web",
  "POST /api/pulls/reply-thread": "web",
  "GET /api/pulls/labels": "web",
  "POST /api/pulls/labels": "web",
  "GET /api/pulls/draft": "web",
  "POST /api/pulls/draft": "web",
  "GET /api/pulls/merge-when-ready": "web",
  "POST /api/pulls/merge-when-ready": "web",
  "DELETE /api/pulls/merge-when-ready": "web",
  "GET /api/pulls/stack": "web",
  "POST /api/pulls/merge-stack": "web",
  "GET /api/pulls/reviewers": "web",
  "POST /api/pulls/reviewers": "web",
  "GET /api/pulls/readiness": "web",
  "GET /api/pulls/review-now": "web",
  "POST /api/pulls/review-now": "web",
  "POST /api/pulls/seen": "web",
  "POST /api/pulls/seen/bulk": "web",
  "GET /api/learnings": "web",
  "GET /api/learnings/proposals": "web",
  "POST /api/learnings": "web",
  "POST /api/learnings/delete": "web",
  "GET /api/repo-config": "web",
  "POST /api/repo-config": "web",
  "GET /api/release-notes": "web",
  "POST /api/release-notes/publish": "web",
  "GET /api/pulls/checks": "web",
  "PATCH /api/merge-checks/repos/:id": "web",
  "GET /api/merge-checks/repos/:id/checks": "web",
  "POST /api/merge-checks/repos/:id/checks": "web",
  "PATCH /api/merge-checks/repos/:id/checks/:check": "web",
  "DELETE /api/merge-checks/repos/:id/checks/:check": "web",
  "GET /api/notifications/channels": "web",
  "POST /api/notifications/channels": "web",
  "PATCH /api/notifications/channels/:id": "web",
  "DELETE /api/notifications/channels/:id": "web",
  "POST /api/notifications/channels/:id/test": "web",
  "POST /api/notifications/channels/:id/secret": "web",
  "GET /api/notifications/channels/:id/deliveries": "web",
  "GET /api/automations/rules": "web",
  "POST /api/automations/rules": "web",
  "PUT /api/automations/rules/:id": "web",
  "DELETE /api/automations/rules/:id": "web",
  "GET /api/automations/runs": "web",
  "POST /api/automations/dry-run": "web",
  "POST /api/notifications/channels/:id/confirm": "web",
  "GET /api/notifications/report": "web",
  "PUT /api/notifications/report": "web",
  "GET /api/notifications/time-zone": "web",
  "PUT /api/notifications/time-zone": "web",
  "GET /api/email/confirm": "public",
  "POST /api/email/confirm": "public",
  "GET /api/email/unsubscribe": "public",
  "POST /api/email/unsubscribe": "public",
  "GET /api/insights/cycle": "web",
  "GET /api/insights/flow": "web",
  "GET /api/insights/impact": "web",
  "GET /api/insights/reviewers": "web",
  "GET /api/insights/at-risk": "web",
  "GET /api/review-targets": "web",
  "PUT /api/review-targets/default": "web",
  "PUT /api/review-targets/repos/:id": "web",
  "DELETE /api/review-targets/repos/:id": "web",
  "GET /api/platforms/repos": "web",
  "POST /api/platforms/sync-names": "web",
  "GET /api/platforms/gitlab/connect": "web",
  "GET /api/platforms/gitlab/callback": "web",
  "PUT /api/budget": "web",
  "GET /api/findings/insights": "web",
  "GET /api/repositories": "web",
  "PUT /api/repositories/:hash": "web",
  "DELETE /api/repositories/:hash": "web",
  "POST /api/findings/decide": "web",
  "DELETE /api/account": "web",
  "GET /api/account/sharing": "web",
  "PUT /api/account/sharing": "web",
  "GET /api/audit": "web",
  "GET /api/account/salt": "web+cli",
  "POST /api/reviews": "web+cli",
  "GET /api/reviews/:id": "web",
  "GET /api/reviews/:id/export": "web",
  "GET /api/reviews": "web",
  "DELETE /api/reviews/:id": "web",
  "GET /api/reviews/:id/chat": "web",
  "POST /api/reviews/:id/chat": "web",
  "DELETE /api/reviews/:id/chat": "web",
  "GET /api/preferences/models": "web+cli",
  "GET /api/preferences": "web+cli",
  "PUT /api/preferences": "web",
  "GET /api/preferences/versions": "web",
  "POST /api/preferences/versions/:id/restore": "web",
  "GET /api/memory": "web+cli",
  "POST /api/memory": "web",
  "DELETE /api/memory/:id": "web",
  "GET /api/keys": "web",
  "PUT /api/keys/:provider": "web",
  "POST /api/keys/:provider/test": "web",
  "GET /api/keys/:provider/models": "web",
  "DELETE /api/keys/:provider": "web",
  "POST /api/gateway/:provider/*": "web+cli",
  "POST /api/live": "cli",
  "GET /api/live": "web",
  "GET /api/live/:id": "web",
  "DELETE /api/live/:id": "web",
  "GET /api/live/:id/events": "web",
  "GET /api/live/:id/stream": "web",
  "GET /api/live/:id/comments": "web",
  "POST /api/live/:id/comments": "web",
  "DELETE /api/live/:id/comments/:commentId": "web",
  "PUT /api/live/:id/link": "web",
  "DELETE /api/live/:id/link": "web",
  "POST /api/live/:id/people": "web",
  "DELETE /api/live/:id/people/:grantId": "web",
};

/** Every route with a handler, as "METHOD /path". */
function registered(): string[] {
  const seen = new Set<string>();
  for (const r of inspectRoutes(app)) {
    if (!r.isMiddleware) seen.add(`${r.method} ${r.path}`);
  }
  return [...seen];
}

/** A concrete URL for a route pattern: each parameter and wildcard filled in. */
const concrete = (path: string) => path.replace(/:\w+/g, "x").replace(/\*$/, "x");

const routes = Object.entries(ACCESS).map(([route, access]) => {
  const [method = "", path = ""] = route.split(" ");
  return { route, method, url: concrete(path), access };
});
const guarded = routes.filter((r) => r.access !== "public");

beforeEach(resetDb);

describe("every route", () => {
  it("is listed with the sessions that may reach it", () => {
    expect(registered().sort()).toEqual(Object.keys(ACCESS).sort());
  });

  it.each(guarded)("$route refuses a request without a session (401)", async (r) => {
    const res = await call(r.url, { method: r.method });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it.each(routes.filter((r) => r.access === "web"))(
    "$route refuses a CLI token (403)",
    async (r) => {
      const { auth } = await signInCli(1, "cli-user");
      const res = await call(r.url, { method: r.method, auth: auth });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden_for_session" });
    },
  );

  it.each(routes.filter((r) => r.access === "cli"))(
    "$route refuses a web session (403)",
    async (r) => {
      const { auth } = await signIn(1, "web-user");
      const res = await call(r.url, { method: r.method, auth: auth });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden_for_session" });
    },
  );

  it.each(routes.filter((r) => r.access === "web+cli" || r.access === "cli"))(
    "$route lets a CLI token through",
    async (r) => {
      const { auth } = await signInCli(1, "cli-user");
      const res = await call(r.url, { method: r.method, auth: auth });
      expect([401, 403]).not.toContain(res.status);
      expect(res.status).toBeLessThan(500);
    },
  );

  it.each(guarded.filter((r) => r.access !== "cli"))(
    "$route lets a web session through",
    async (r) => {
      const { auth } = await signIn(1, "web-user");
      const res = await call(r.url, { method: r.method, auth: auth });
      expect([401, 403]).not.toContain(res.status);
      expect(res.status).toBeLessThan(500);
    },
  );
});

// A personal API token reaches the routes API_TOKEN_ROUTES lists, with the
// scope listed, and nothing else, whatever scopes it holds.
describe("every route, with a personal API token", () => {
  const allowed = guarded.filter((r) => Object.hasOwn(API_TOKEN_ROUTES, r.route));

  it("lists only registered GET routes", () => {
    const listed = Object.keys(API_TOKEN_ROUTES);
    expect(listed.filter((r) => !Object.hasOwn(ACCESS, r))).toEqual([]);
    expect(listed.filter((r) => !r.startsWith("GET "))).toEqual([]);
  });

  it.each(guarded.filter((r) => !Object.hasOwn(API_TOKEN_ROUTES, r.route)))(
    "$route refuses a token with every scope (403)",
    async (r) => {
      const { auth } = await signInToken(1, "script", API_TOKEN_SCOPES);
      const res = await call(r.url, { method: r.method, auth });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden_for_session" });
    },
  );

  it.each(allowed)("$route lets a token with its scope through", async (r) => {
    const scope = API_TOKEN_ROUTES[r.route] as string;
    const { auth } = await signInToken(1, "script", [scope]);
    const res = await call(r.url, { method: r.method, auth });
    expect([401, 403]).not.toContain(res.status);
    expect(res.status).toBeLessThan(500);
  });

  it.each(allowed)("$route refuses a token without its scope (403)", async (r) => {
    const scope = API_TOKEN_ROUTES[r.route];
    const others = API_TOKEN_SCOPES.filter((s) => s !== scope);
    const { auth } = await signInToken(1, "script", others);
    const res = await call(r.url, { method: r.method, auth });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_for_session", scope });
  });
});
