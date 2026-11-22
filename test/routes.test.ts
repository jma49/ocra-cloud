import { inspectRoutes } from "hono/dev";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

// Every route the app serves, and which sessions reach it. A route added
// without a line here fails the first test; a route whose router lost its
// guard answers an unauthenticated request with something other than 401
// (usually a 500, reading a session that is not there) and fails the second.

type Access = "public" | "web" | "web+cli";

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
  "GET /api/export": "web",
  "GET /api/findings": "web",
  "GET /api/budget": "web",
  "GET /api/platforms/pulls": "web",
  "GET /api/pull-views": "web",
  "POST /api/pull-views": "web",
  "PUT /api/pull-views/:id": "web",
  "DELETE /api/pull-views/:id": "web",
  "GET /api/pulls/files": "web",
  "POST /api/pulls/comment": "web",
  "POST /api/pulls/review": "web",
  "POST /api/pulls/merge": "web",
  "GET /api/pulls/queue": "web",
  "POST /api/pulls/enqueue": "web",
  "POST /api/pulls/dequeue": "web",
  "POST /api/pulls/apply-fix": "web",
  "GET /api/pulls/stack": "web",
  "POST /api/pulls/merge-stack": "web",
  "GET /api/learnings": "web",
  "GET /api/learnings/proposals": "web",
  "POST /api/learnings": "web",
  "POST /api/learnings/delete": "web",
  "GET /api/notifications/channels": "web",
  "POST /api/notifications/channels": "web",
  "PATCH /api/notifications/channels/:id": "web",
  "DELETE /api/notifications/channels/:id": "web",
  "POST /api/notifications/channels/:id/test": "web",
  "GET /api/automations/rules": "web",
  "POST /api/automations/rules": "web",
  "PUT /api/automations/rules/:id": "web",
  "DELETE /api/automations/rules/:id": "web",
  "GET /api/automations/runs": "web",
  "POST /api/automations/dry-run": "web",
  "GET /api/insights/cycle": "web",
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
  "GET /api/account/salt": "web+cli",
  "POST /api/reviews": "web+cli",
  "GET /api/reviews/:id": "web",
  "GET /api/reviews/:id/export": "web",
  "GET /api/reviews": "web",
  "DELETE /api/reviews/:id": "web",
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

  it.each(routes.filter((r) => r.access === "web+cli"))(
    "$route lets a CLI token through",
    async (r) => {
      const { auth } = await signInCli(1, "cli-user");
      const res = await call(r.url, { method: r.method, auth: auth });
      expect([401, 403]).not.toContain(res.status);
      expect(res.status).toBeLessThan(500);
    },
  );

  it.each(guarded)("$route lets a web session through", async (r) => {
    const { auth } = await signIn(1, "web-user");
    const res = await call(r.url, { method: r.method, auth: auth });
    expect([401, 403]).not.toContain(res.status);
    expect(res.status).toBeLessThan(500);
  });
});
