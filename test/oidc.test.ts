import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pkceChallenge } from "../src/crypto.js";
import { forgetDiscovery } from "../src/oidc.js";
import { call, resetDb } from "./helpers.js";

// Signing in through the deployment's OpenID Connect provider
// (vitest.config.ts sets one up as https://sso.example.com/realms/eng).

beforeEach(async () => {
  await resetDb();
  forgetDiscovery();
});
afterEach(() => vi.restoreAllMocks());

const ISSUER = "https://sso.example.com/realms/eng";
const SESSION = "__Host-ocra_session";
const STATE = "__Host-ocra_oauth_state";

const discovery = (overrides: Record<string, string> = {}) => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
  ...overrides,
});

function provider(user: Record<string, unknown>, doc = discovery()) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockClear()
    .mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url === `${ISSUER}/.well-known/openid-configuration`) return Response.json(doc);
      if (req.url === doc.token_endpoint) return Response.json({ access_token: "at-1" });
      if (req.url === doc.userinfo_endpoint) {
        return req.headers.get("authorization") === "Bearer at-1"
          ? Response.json(user)
          : new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch ${req.url}`);
    });
}

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((l) => l.split(";")[0] ?? "")
    .find((p) => p.startsWith(`${name}=`));

/** Starts a sign-in and comes back through the callback, as the provider would send the browser. */
async function signInThrough(next?: string) {
  const start = await call(`/api/auth/oidc/login${next ? `?next=${next}` : ""}`);
  const to = new URL(start.headers.get("location") ?? "");
  const res = await call(`/api/auth/oidc/callback?code=c-1&state=${to.searchParams.get("state")}`, {
    headers: { cookie: cookieOf(start, STATE) ?? "" },
  });
  return { to, res };
}

describe("OpenID Connect sign-in", () => {
  it("is listed with GitHub among the deployment's ways to sign in", async () => {
    const res = await call("/api/auth/methods");
    expect(await res.json()).toEqual({
      methods: [
        { id: "github", name: "GitHub" },
        { id: "oidc", name: "Example SSO" },
      ],
    });
  });

  it("sends the browser to the provider with a state and a PKCE challenge", async () => {
    provider({ sub: "u-1" });
    const res = await call("/api/auth/oidc/login");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "ocra-cloud",
      redirect_uri: "https://ocra.test/api/auth/oidc/callback",
      scope: "openid profile email",
      code_challenge_method: "S256",
    });
    expect(to.searchParams.get("state")).toBeTruthy();
    expect(to.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  });

  it("signs in as the provider's subject, proving the challenge and keeping the secret upstream", async () => {
    const fake = provider({ sub: "u-1", preferred_username: "ada", email: "ada@example.com" });
    const { to, res } = await signInThrough("/findings");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/findings");

    const tokenCall = fake.mock.calls
      .map(([input, init]) => new Request(input, init))
      .find((r) => r.url.endsWith("/token"));
    const form = new URLSearchParams(await tokenCall?.text());
    expect(form.get("code")).toBe("c-1");
    expect(await pkceChallenge(form.get("code_verifier") ?? "")).toBe(
      to.searchParams.get("code_challenge"),
    );
    expect(tokenCall?.headers.get("authorization")).toBe(
      `Basic ${btoa("ocra-cloud:test-oidc-secret")}`,
    );
    expect(to.toString()).not.toContain("test-oidc-secret");

    const session = cookieOf(res, SESSION);
    const me = await call("/api/me", { headers: { cookie: session ?? "" } });
    expect(await me.json()).toMatchObject({ login: "ada", githubId: null, session: "web" });
  });

  it("finds the same account on the next sign-in, with the login kept current", async () => {
    provider({ sub: "u-1", preferred_username: "ada" });
    const first = await signInThrough();
    vi.restoreAllMocks();
    provider({ sub: "u-1", preferred_username: "ada.l" });
    const second = await signInThrough();
    const meOf = async (res: Response) =>
      (await call("/api/me", { headers: { cookie: cookieOf(res, SESSION) ?? "" } })).json();
    const [a, b] = (await Promise.all([meOf(first.res), meOf(second.res)])) as {
      login: string;
      since: string;
    }[];
    expect(b?.login).toBe("ada.l");
    expect(b?.since).toBe(a?.since);
  });

  it("refuses a callback whose state the browser did not start", async () => {
    provider({ sub: "u-1" });
    const start = await call("/api/auth/oidc/login");
    const res = await call("/api/auth/oidc/callback?code=c-1&state=forged", {
      headers: { cookie: cookieOf(start, STATE) ?? "" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_state" });
  });

  it.each([
    ["names another issuer", discovery({ issuer: "https://evil.example" })],
    [
      "moves an endpoint off https",
      discovery({ token_endpoint: "http://sso.example.com/realms/eng/token" }),
    ],
  ])("refuses a discovery document that %s", async (_why, doc) => {
    provider({ sub: "u-1" }, doc);
    const res = await call("/api/auth/oidc/login");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "upstream_unreachable" });
  });

  it("refuses a userinfo answer without a subject", async () => {
    provider({ preferred_username: "nobody" });
    const { res } = await signInThrough();
    expect(res.status).toBe(502);
    expect(cookieOf(res, SESSION)).toBeUndefined();
  });
});
