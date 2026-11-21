import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_HEADERS } from "../src/app.js";
import { githubIdentity, upsertAccount } from "../src/db/accounts.js";
import * as schema from "../src/db/schema.js";
import { bindingsFrom } from "../src/node/env.js";
import { openHost, parseHeaders } from "../src/node/host.js";
import { memoryRateLimit } from "../src/node/limits.js";
import { startCliSession, startWebSession } from "../src/session.js";
import { finding, upload } from "../test/finding-uploads.js";

// The self-hosted server: the same app on Node and libSQL (a SQLite file),
// end to end through its migrations, a signed-in upload, a decision, a
// cascade and the web app's files.

const ORIGIN = "http://ocra.test";
const VARS = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
};

let dir: string;
let host: Awaited<ReturnType<typeof openHost>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-host-"));
  const web = join(dir, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "<!doctype html><p>console</p>");
  await writeFile(join(web, "_headers"), "/*\n  X-Frame-Options: DENY\n");
  host = await openHost({
    databaseUrl: `file:${join(dir, "ocra.db")}`,
    bindings: bindingsFrom(VARS),
    migrations: resolve("migrations"),
    web,
  });
});

afterAll(async () => {
  host?.close();
  await rm(dir, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  return host.fetch(
    new Request(ORIGIN + path, {
      ...rest,
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    }),
  );
};

describe("the self-hosted server", () => {
  it("refuses to start without its secrets, naming them", () => {
    expect(() => bindingsFrom({ ...VARS, MASTER_KEY: "", SESSION_SECRET: undefined })).toThrow(
      "missing environment variables: MASTER_KEY, SESSION_SECRET",
    );
  });

  it("starts with OpenID Connect as its only sign-in, and refuses to start with none", async () => {
    const { GITHUB_CLIENT_ID: _id, GITHUB_CLIENT_SECRET: _secret, ...rest } = VARS;
    const sso = {
      OIDC_ISSUER: "https://sso.example.com",
      OIDC_CLIENT_ID: "o",
      OIDC_CLIENT_SECRET: "s",
    };
    expect(bindingsFrom({ ...rest, ...sso })).toMatchObject({
      OIDC_ISSUER: "https://sso.example.com",
    });
    expect(bindingsFrom({ ...rest, ...sso }).GITHUB_CLIENT_ID).toBeUndefined();
    expect(() => bindingsFrom({ ...rest, OIDC_ISSUER: "https://sso.example.com" })).toThrow(
      "no way to sign in: set GitHub (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET) or OpenID Connect (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)",
    );
  });

  it("answers the API with its headers", async () => {
    const res = await call("/api/health");
    expect(await res.json()).toEqual({ ok: true });
    for (const [name, value] of Object.entries(API_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
    expect((await call("/api/nope")).status).toBe(404);
  });

  it("takes an upload, a decision and a deletion on SQLite as on D1", async () => {
    const account = await upsertAccount(host.db, githubIdentity(1), "octo");
    const web = { authorization: `Bearer ${await startWebSession(host.db, account.id)}` };
    const cli = {
      authorization: `Bearer ${(await startCliSession(host.db, account.id, "terminal")).access_token}`,
    };
    const me = await call("/api/me", { headers: cli });
    expect(await me.json()).toMatchObject({ login: "octo" });

    const sharing = await call("/api/account/sharing", {
      method: "PUT",
      headers: { ...web, origin: ORIGIN },
      json: { enabled: true },
    });
    expect(sharing.status).toBe(200);
    const posted = await call("/api/reviews", {
      method: "POST",
      headers: cli,
      json: upload("r1", [finding({ fingerprint: "fp-1" }), finding({ fingerprint: "fp-2" })]),
    });
    expect(posted.status).toBe(200);

    const listed = (await (await call("/api/findings", { headers: web })).json()) as {
      findings: { id: string }[];
    };
    expect(listed.findings).toHaveLength(2);
    // A write's count of changed rows, read from libSQL's result.
    const decided = await call("/api/findings/decide", {
      method: "POST",
      headers: { ...web, origin: ORIGIN },
      json: { ids: listed.findings.map((f) => f.id), status: "fixed" },
    });
    expect(await decided.json()).toEqual({ changed: 2, remembered: 0 });

    const findingsOf = () =>
      host.db
        .select({ n: count() })
        .from(schema.findings)
        .where(eq(schema.findings.accountId, account.id))
        .limit(1)
        .then((r) => r[0]);
    expect((await findingsOf())?.n).toBe(2);
    await host.db.delete(schema.accounts).where(eq(schema.accounts.id, account.id));
    // Foreign keys are on, so the account's findings went with it.
    expect((await findingsOf())?.n).toBe(0);
  });

  it("serves the web app, its routes and its headers", async () => {
    const home = await call("/");
    expect(await home.text()).toContain("console");
    expect(home.headers.get("x-frame-options")).toBe("DENY");
    const route = await call("/findings");
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("console");
  });
});

describe("behind a proxy that ends TLS", () => {
  it("reads requests at the public address, so a same-origin write passes", async () => {
    const proxied = await openHost({
      databaseUrl: `file:${join(dir, "proxied.db")}`,
      bindings: bindingsFrom(VARS),
      migrations: resolve("migrations"),
      publicUrl: "https://ocra.example.com/",
    });
    try {
      const account = await upsertAccount(proxied.db, githubIdentity(2), "proxied");
      // The browser's cookie: only a cookie request has its origin checked.
      const auth = {
        cookie: `__Host-ocra_session=${await startWebSession(proxied.db, account.id)}`,
      };
      const put = (origin: string) =>
        proxied.fetch(
          new Request("http://10.0.0.5:8787/api/account/sharing", {
            method: "PUT",
            headers: { ...auth, origin, "content-type": "application/json" },
            body: JSON.stringify({ enabled: true }),
          }),
        );
      expect((await put("https://ocra.example.com")).status).toBe(200);
      expect((await put("http://10.0.0.5:8787")).status).toBe(403);
    } finally {
      proxied.close();
    }
  });
});

describe("the login code limit", () => {
  const askForCode = (target: Awaited<ReturnType<typeof openHost>>, headers: HeadersInit) =>
    target.fetch(
      new Request(`${ORIGIN}/api/device/code`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      }),
    );

  it("counts by the client's address, not by a header the client sets", async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await askForCode(host, { "cf-connecting-ip": `192.0.2.${i}` })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("reads the address past the trusted proxy, ignoring what the client prepended", async () => {
    const proxied = await openHost({
      databaseUrl: `file:${join(dir, "hops.db")}`,
      bindings: bindingsFrom(VARS),
      migrations: resolve("migrations"),
      trustedProxyHops: 1,
    });
    try {
      const statuses = [];
      for (let i = 0; i < 11; i++) {
        const forwarded = `192.0.2.${i}, 198.51.100.7`;
        statuses.push((await askForCode(proxied, { "x-forwarded-for": forwarded })).status);
      }
      expect(statuses[10]).toBe(429);
      const other = await askForCode(proxied, { "x-forwarded-for": "198.51.100.8" });
      expect(other.status).toBe(200);
    } finally {
      proxied.close();
    }
  });
});

describe("the in-memory rate limit", () => {
  it("allows `limit` calls per key in a window", async () => {
    const limit = memoryRateLimit(2, 60);
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await limit.limit({ key: "a" })).success);
    expect(results).toEqual([true, true, false]);
    expect((await limit.limit({ key: "b" })).success).toBe(true);
  });

  it("reads the headers of a _headers file's /* block", () => {
    expect(parseHeaders("# c\n/*\n  A: 1\n  B: x: y\n/api/*\n  C: 2\n")).toEqual([
      ["A", "1"],
      ["B", "x: y"],
    ]);
  });
});
