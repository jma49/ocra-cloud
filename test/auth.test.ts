import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, ORIGIN, resetDb, signIn } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

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
    expect(cookieValue(res, "ocra_oauth_state")).toBeTruthy();
  });

  it("signs in, sets an HttpOnly session cookie, and /me answers with it", async () => {
    const fake = githubFake({ id: 42, login: "octo" });
    const start = await call("/api/auth/github/login");
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const stateCookie = cookieValue(start, "ocra_oauth_state");
    const res = await call(`/api/auth/github/callback?code=c&state=${state}`, {
      headers: { cookie: `ocra_oauth_state=${stateCookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const session = cookieValue(res, "ocra_session");
    expect(session).toMatch(/^ocra_web_/);
    expect(res.headers.getSetCookie().find((l) => l.startsWith("ocra_session="))).toMatch(
      /HttpOnly.*Secure|Secure.*HttpOnly/,
    );
    // The client secret goes to GitHub's token endpoint only.
    const exchange = fake.mock.calls.find(([i]) => new Request(i).url.includes("access_token"));
    expect(String(exchange?.[1]?.body)).toContain("test-client-secret");

    const me = await call("/api/me", { headers: { cookie: `ocra_session=${session}` } });
    expect(await me.json()).toMatchObject({ login: "octo", githubId: 42, session: "web" });
  });

  it("refuses a callback whose state does not match the signed cookie", async () => {
    githubFake({ id: 1, login: "x" });
    const start = await call("/api/auth/github/login");
    const stateCookie = cookieValue(start, "ocra_oauth_state");
    const res = await call("/api/auth/github/callback?code=c&state=forged", {
      headers: { cookie: `ocra_oauth_state=${stateCookie}` },
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
    expect((await call("/api/me", { headers: auth })).status).toBe(200);
    expect((await call("/api/auth/logout", { method: "POST", headers: auth })).status).toBe(200);
    expect((await call("/api/me", { headers: auth })).status).toBe(401);
  });

  it("refuses a cookie request that changes something from another origin", async () => {
    const { token } = await signIn(8, "v");
    const cookie = `ocra_session=${token}`;
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
