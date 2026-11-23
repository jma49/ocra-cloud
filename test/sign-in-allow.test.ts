import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { forgetDiscovery } from "../src/oidc.js";
import { HOUR } from "../src/time.js";
import { call, db, resetDb, signIn, signInCli, signInToken } from "./helpers.js";

// SIGN_IN_ALLOW: who may sign in to a self-hosted server, at sign-in and on
// every later request of the account's sessions and API tokens.

beforeEach(async () => {
  await resetDb();
  forgetDiscovery();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Moves the clock on by `ms`, as if that long passed since now. */
function later(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
}

const SESSION = "__Host-ocra_session";
const STATE = "__Host-ocra_oauth_state";
const ISSUER = "https://sso.example.com/realms/eng";
const NOT_ALLOWED = { reason: "sign_in_not_allowed" };

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((l) => l.split(";")[0] ?? "")
    .find((p) => p.startsWith(`${name}=`));

type GithubWorld = {
  user: { id: number; login: string };
  /** Each organisation's membership state for the user; absent ones answer 404. */
  orgs?: Record<string, string>;
  emails?: { email: string; verified: boolean }[];
};

/** GitHub as sign-in and the checks after it see it; `calls` lists the API paths asked. */
function githubFake(world: GithubWorld) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch")
    .mockClear()
    .mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (req.url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "gho_test" });
      }
      if (url.origin !== "https://api.github.com") throw new Error(`unexpected fetch ${req.url}`);
      calls.push(url.pathname);
      if (url.pathname === "/user") return Response.json(world.user);
      if (url.pathname === "/user/emails") return Response.json(world.emails ?? []);
      const org = url.pathname.match(/^\/user\/memberships\/orgs\/(.+)$/)?.[1];
      const state = org ? world.orgs?.[decodeURIComponent(org)] : undefined;
      if (state) return Response.json({ state });
      return Response.json({ message: "Not Found" }, { status: 404 });
    });
  return calls;
}

async function githubSignIn(allow: string) {
  const env = { SIGN_IN_ALLOW: allow };
  const start = await call("/api/auth/github/login", {}, env);
  const to = new URL(start.headers.get("location") ?? "");
  const res = await call(
    `/api/auth/github/callback?code=c&state=${to.searchParams.get("state")}`,
    { headers: { cookie: cookieOf(start, STATE) ?? "" } },
    env,
  );
  const session = cookieOf(res, SESSION);
  return { to, res, session, cookie: { cookie: session ?? "" } };
}

const accountCount = async () => (await db.select().from(schema.accounts)).length;

describe("GitHub sign-in with SIGN_IN_ALLOW", () => {
  it("refuses a user it does not list, makes no account, and offers no GitHub sign-up", async () => {
    githubFake({ user: { id: 5, login: "mallory" }, orgs: { other: "active" } });
    const { to, res, session } = await githubSignIn("org:acme, user:ada");
    expect(to.searchParams.get("allow_signup")).toBe("false");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_for_session", ...NOT_ALLOWED });
    expect(session).toBeUndefined();
    expect(await accountCount()).toBe(0);
  });

  it("lets in a listed login, compared without case", async () => {
    githubFake({ user: { id: 1, login: "Ada" } });
    const { res, session } = await githubSignIn("user:ADA");
    expect(res.status).toBe(302);
    expect(session).toBeDefined();
  });

  it("lets in an active member of a listed organisation, and not a pending one", async () => {
    githubFake({ user: { id: 1, login: "ada" }, orgs: { acme: "active" } });
    expect((await githubSignIn("org:Acme")).res.status).toBe(302);
    await resetDb();
    githubFake({ user: { id: 1, login: "ada" }, orgs: { acme: "pending" } });
    expect((await githubSignIn("org:acme")).res.status).toBe(403);
  });

  it("lets in a verified email's domain only, its Unicode form normalised", async () => {
    githubFake({
      user: { id: 1, login: "ada" },
      emails: [{ email: "ada@xn--bcher-kva.example", verified: true }],
    });
    expect((await githubSignIn("domain:Bücher.example")).res.status).toBe(302);
    await resetDb();
    githubFake({
      user: { id: 1, login: "ada" },
      emails: [{ email: "ada@acme.com", verified: false }],
    });
    expect((await githubSignIn("domain:acme.com")).res.status).toBe(403);
  });

  it("sends people to GitHub's sign-up as before when no list is set", async () => {
    const start = await call("/api/auth/github/login");
    expect(new URL(start.headers.get("location") ?? "").searchParams.get("allow_signup")).toBe(
      "true",
    );
  });
});

describe("sessions and tokens once the account no longer matches", () => {
  it("refuses a web session, a CLI session and an API token of an account the list leaves out", async () => {
    const web = await signIn(5, "mallory");
    const cli = await signInCli(5, "mallory");
    const token = await signInToken(5, "mallory", ["reviews:read"]);
    const reached = [
      ["/api/me", web.auth],
      ["/api/me", cli.auth],
      ["/api/reviews", token.auth],
    ] as const;
    for (const [path, auth] of reached) {
      expect((await call(path, { auth })).status).toBe(200);
      const res = await call(path, { auth }, { SIGN_IN_ALLOW: "user:ada" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated", ...NOT_ALLOWED });
    }
  });

  it("asks GitHub at most hourly, and refuses once the user has left the organisation", async () => {
    const env = { SIGN_IN_ALLOW: "org:acme" };
    const world: GithubWorld = { user: { id: 1, login: "ada" }, orgs: { acme: "active" } };
    const calls = githubFake(world);
    const { cookie } = await githubSignIn("org:acme");
    calls.length = 0;
    expect((await call("/api/me", { headers: cookie }, env)).status).toBe(200);
    expect(calls).toEqual([]);

    world.orgs = {};
    later(HOUR + 1000);
    const res = await call("/api/me", { headers: cookie }, env);
    expect(res.status).toBe(401);
    expect(calls).toEqual(["/user", "/user/memberships/orgs/acme"]);
    // The refusal is kept: the next request asks GitHub nothing.
    calls.length = 0;
    expect((await call("/api/me", { headers: cookie }, env)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("checks again at once when the list changes", async () => {
    const calls = githubFake({ user: { id: 1, login: "ada" } });
    const { cookie } = await githubSignIn("user:ada");
    calls.length = 0;
    const res = await call("/api/me", { headers: cookie }, { SIGN_IN_ALLOW: "user:grace" });
    expect(res.status).toBe(401);
    expect(calls).toEqual(["/user"]);
  });
});

function sso(user: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch")
    .mockClear()
    .mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url === `${ISSUER}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          userinfo_endpoint: `${ISSUER}/userinfo`,
        });
      }
      if (req.url === `${ISSUER}/token`) return Response.json({ access_token: "at-1" });
      if (req.url === `${ISSUER}/userinfo`) return Response.json(user);
      throw new Error(`unexpected fetch ${req.url}`);
    });
}

async function ssoSignIn(allow: string) {
  const env = { SIGN_IN_ALLOW: allow };
  const start = await call("/api/auth/oidc/login", {}, env);
  const to = new URL(start.headers.get("location") ?? "");
  const res = await call(
    `/api/auth/oidc/callback?code=c-1&state=${to.searchParams.get("state")}`,
    { headers: { cookie: cookieOf(start, STATE) ?? "" } },
    env,
  );
  const session = cookieOf(res, SESSION);
  return { res, session, cookie: { cookie: session ?? "" } };
}

describe("OpenID Connect sign-in with SIGN_IN_ALLOW", () => {
  it("refuses a subject that matches no entry, and makes no account", async () => {
    sso({ sub: "u-1", email: "eve@elsewhere.example", email_verified: true, groups: ["guests"] });
    const { res, session } = await ssoSignIn("domain:acme.com, group:eng");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_for_session", ...NOT_ALLOWED });
    expect(session).toBeUndefined();
    expect(await accountCount()).toBe(0);
  });

  it("lets in a verified email's domain, and not an unverified one", async () => {
    sso({ sub: "u-1", email: "ada@ACME.com", email_verified: true });
    expect((await ssoSignIn("domain:acme.com")).res.status).toBe(302);
    await resetDb();
    sso({ sub: "u-1", email: "ada@acme.com" });
    expect((await ssoSignIn("domain:acme.com")).res.status).toBe(403);
  });

  it("lets in a listed group, and refuses its sessions once the list changes", async () => {
    sso({ sub: "u-1", groups: ["company/eng"] });
    const { res, cookie } = await ssoSignIn("group:company/eng");
    expect(res.status).toBe(302);
    const same = { SIGN_IN_ALLOW: "group:company/eng" };
    expect((await call("/api/me", { headers: cookie }, same)).status).toBe(200);
    // Past the hour, the sign-in's answer stands while the list is the same.
    later(2 * HOUR);
    expect((await call("/api/me", { headers: cookie }, same)).status).toBe(200);
    const changed = { SIGN_IN_ALLOW: "group:company/eng,domain:acme.com" };
    expect((await call("/api/me", { headers: cookie }, changed)).status).toBe(401);
  });
});
