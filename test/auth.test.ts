import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

// Audit S-hard (#15): both cookies carry the __Host- prefix, so a sibling
// subdomain cannot plant one.
const SESSION = "__Host-ocra_session";
const STATE = "__Host-ocra_oauth_state";

function cookieValue(res: Response, name: string): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [k, v] = (pair ?? "").split("=");
    if (k === name) return v;
  }
  return undefined;
}

function githubFake(user: { id: number; login: string }) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockClear()
    .mockImplementation(async (input) => {
      const url = new Request(input).url;
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "gho_test" });
      }
      if (url === "https://api.github.com/user") return Response.json(user);
      throw new Error(`unexpected fetch ${url}`);
    });
}

describe("GitHub sign-in", () => {
  it("redirects to GitHub with a state that the callback must return", async () => {
    const res = await call("/api/auth/github/login");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/github/callback`);
    const state = to.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(cookieValue(res, STATE)).toBeTruthy();
    // __Host- cookies must be Secure, Path=/ and carry no Domain.
    const line = res.headers.getSetCookie().find((l) => l.startsWith(`${STATE}=`)) ?? "";
    expect(line).toMatch(/; Secure/);
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).not.toMatch(/Domain=/i);
  });

  it("signs in, sets an HttpOnly session cookie, and /me answers with it", async () => {
    const fake = githubFake({ id: 42, login: "octo" });
    const start = await call("/api/auth/github/login");
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const stateCookie = cookieValue(start, STATE);
    const res = await call(`/api/auth/github/callback?code=c&state=${state}`, {
      headers: { cookie: `${STATE}=${stateCookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const session = cookieValue(res, SESSION);
    expect(session).toMatch(/^ocra_web_/);
    const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION}=`)) ?? "";
    expect(line).toMatch(/; HttpOnly/);
    expect(line).toMatch(/; Secure/);
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).not.toMatch(/Domain=/i);
    // The client secret goes to GitHub's token endpoint only.
    const exchange = fake.mock.calls.find(([i]) => new Request(i).url.includes("access_token"));
    expect(String(exchange?.[1]?.body)).toContain("test-client-secret");

    const me = await call("/api/me", { headers: { cookie: `${SESSION}=${session}` } });
    expect(await me.json()).toMatchObject({
      login: "octo",
      githubId: 42,
      session: "web",
      codeGraphs: "off",
      autoReview: false,
      platforms: ["github", "gitlab"],
    });
  });

  it("ends the browser session that signing in again replaces, and no other", async () => {
    githubFake({ id: 42, login: "octo" });
    const before = await signIn(42, "octo");
    const cli = await signInCli(42, "octo");
    const signInWith = async (cookie: string) => {
      const start = await call("/api/auth/github/login");
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
      const res = await call(`/api/auth/github/callback?code=c&state=${state}`, {
        headers: { cookie: `${STATE}=${cookieValue(start, STATE)}; ${cookie}` },
      });
      expect(res.status).toBe(302);
      return cookieValue(res, SESSION);
    };
    const after = await signInWith(`${SESSION}=${before.token}`);
    expect((await call("/api/me", { auth: before.auth })).status).toBe(401);
    expect((await call("/api/me", { headers: { cookie: `${SESSION}=${after}` } })).status).toBe(
      200,
    );
    // Only a browser session ends this way, not the CLI's, whatever the cookie holds.
    await signInWith(`${SESSION}=${cli.tokens.access_token}`);
    expect((await call("/api/me", { auth: cli.auth })).status).toBe(200);
  });

  it("refuses a callback whose state does not match the signed cookie", async () => {
    githubFake({ id: 1, login: "x" });
    const start = await call("/api/auth/github/login");
    const stateCookie = cookieValue(start, STATE);
    const res = await call("/api/auth/github/callback?code=c&state=forged", {
      headers: { cookie: `${STATE}=${stateCookie}` },
    });
    expect(res.status).toBe(400);
    const noCookie = await call("/api/auth/github/callback?code=c&state=forged");
    expect(noCookie.status).toBe(400);
  });
});

describe("sessions", () => {
  it("rejects missing, unknown and logged-out tokens", async () => {
    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/me", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const { auth } = await signIn(7, "u");
    expect((await call("/api/me", { auth: auth })).status).toBe(200);
    expect((await call("/api/auth/logout", { method: "POST", auth: auth })).status).toBe(200);
    expect((await call("/api/me", { auth: auth })).status).toBe(401);
  });

  it("reads the session only from the __Host- cookie, not the old name", async () => {
    const { token } = await signIn(9, "w");
    const old = await call("/api/me", { headers: { cookie: `ocra_session=${token}` } });
    expect(old.status).toBe(401);
    const now = await call("/api/me", { headers: { cookie: `${SESSION}=${token}` } });
    expect(now.status).toBe(200);
    const out = await call("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION}=${token}`, origin: ORIGIN },
    });
    const cleared = out.headers.getSetCookie().find((l) => l.startsWith(`${SESSION}=`)) ?? "";
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(/; Path=\/(;|$)/);
  });

  it("refuses a cookie request that changes something from another origin", async () => {
    const { token } = await signIn(8, "v");
    const cookie = `${SESSION}=${token}`;
    const cross = await call("/api/keys/openrouter", {
      method: "DELETE",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
    const missing = await call("/api/keys/openrouter", { method: "DELETE", headers: { cookie } });
    expect(missing.status).toBe(403);
    const same = await call("/api/keys/openrouter", {
      method: "DELETE",
      headers: { cookie, origin: ORIGIN },
    });
    expect(same.status).toBe(200);
  });
});
