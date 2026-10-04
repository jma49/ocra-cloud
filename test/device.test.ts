import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { REFRESH_GRACE_MS, safeNext } from "../src/auth.js";
import { sha256Hex } from "../src/crypto.js";
import { rotateSession, sessionByRefreshHash } from "../src/db/accounts.js";
import * as schema from "../src/db/schema.js";
import { normalizeUserCode } from "../src/device.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(async () => {
  await resetDb();
  await db.delete(schema.deviceCodes);
});

const json = { "content-type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });

type CodeAnswer = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

async function startLogin(ip = "198.51.100.1") {
  const res = await post(
    "/api/device/code",
    { client_name: "MacBook (ocra 0.4.0)" },
    { "cf-connecting-ip": ip },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as CodeAnswer;
}

/** Lets the next poll through, as if the interval had passed. */
const waitInterval = () => db.update(schema.deviceCodes).set({ lastPolledAt: null });

const poll = async (deviceCode: string) => {
  await waitInterval();
  const res = await post("/api/device/token", { device_code: deviceCode });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("ocra login (device flow)", () => {
  it("issues a code, waits for approval, then gives the CLI scoped tokens once", async () => {
    const code = await startLogin();
    expect(code.user_code).toMatch(/^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/);
    expect(code.verification_uri).toBe("https://ocra.test/device");
    expect(code.verification_uri_complete).toBe(`https://ocra.test/device?code=${code.user_code}`);
    expect(code).toMatchObject({ expires_in: 600, interval: 5 });

    expect((await poll(code.device_code)).body).toEqual({ error: "authorization_pending" });

    const me = await signIn(1, "octo");
    const info = await call(
      `/api/device/info?user_code=${code.user_code.toLowerCase().replace("-", "")}`,
      {
        headers: me.auth,
      },
    );
    expect(await info.json()).toMatchObject({
      user_code: code.user_code,
      label: "MacBook (ocra 0.4.0)",
    });
    const decided = await post(
      "/api/device/decide",
      { user_code: code.user_code, approve: true },
      me.auth,
    );
    expect(await decided.json()).toEqual({ approved: true });

    const granted = await poll(code.device_code);
    expect(granted.status).toBe(200);
    const tokens = granted.body as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(tokens.access_token).toMatch(/^ocra_cli_/);
    expect(tokens.expires_in).toBe(3600);

    // The CLI token reaches whoami and the gateway, never keys or the account.
    const cli = { authorization: `Bearer ${tokens.access_token}` };
    expect(await (await call("/api/me", { headers: cli })).json()).toMatchObject({
      login: "octo",
      session: "cli",
    });
    expect((await call("/api/keys", { headers: cli })).status).toBe(403);
    expect((await call("/api/sessions", { headers: cli })).status).toBe(403);
    expect((await post("/api/device/decide", { user_code: "x", approve: true }, cli)).status).toBe(
      403,
    );
    const gw = await post("/api/gateway/openrouter/v1/chat/completions", { model: "m" }, cli);
    expect(gw.status).toBe(400); // no key stored: it got past the session check

    // The code works once.
    expect((await poll(code.device_code)).body).toEqual({ error: "invalid_grant" });
  });

  const me = (token: string) =>
    call("/api/me", { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
  const refresh = async (token: string) => {
    const res = await post("/api/device/refresh", { refresh_token: token });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };
  const cliSession = () =>
    db.select().from(schema.sessions).where(eq(schema.sessions.kind, "cli")).get();

  it("refresh rotates the pair; the old access token works until its own expiry", async () => {
    const { tokens } = await signInCli(1, "octo");
    const next = await refresh(tokens.refresh_token);
    expect(next.status).toBe(200);
    expect(next.body.access_token).not.toBe(tokens.access_token);
    // Another ocra process still using the old token keeps working.
    expect(await me(tokens.access_token)).toBe(200);
    expect(await me(next.body.access_token ?? "")).toBe(200);
    // Once its own hour is over, it stops.
    await db.update(schema.sessions).set({ prevExpiresAt: new Date(Date.now() - 1000) });
    expect(await me(tokens.access_token)).toBe(401);
    expect(await me(next.body.access_token ?? "")).toBe(200);
  });

  it("of two refreshes with the same token, exactly one rotation wins", async () => {
    const { tokens } = await signInCli(1, "octo");
    const before = await sessionByRefreshHash(db, await sha256Hex(tokens.refresh_token));
    expect((await refresh(tokens.refresh_token)).status).toBe(200);
    // The loser read the row before the winner's update landed: its
    // compare-and-set on the old refresh hash changes nothing.
    expect(
      await rotateSession(db, before?.sessionId ?? "", before?.refreshHash ?? "", {
        tokenHash: "loser",
      }),
    ).toBe(false);
    expect((await cliSession())?.tokenHash).not.toBe("loser");
  });

  it("a used refresh token answers once more within the grace window, for a lost response", async () => {
    const { tokens } = await signInCli(1, "octo");
    const lost = await refresh(tokens.refresh_token);
    expect(lost.status).toBe(200);
    const retry = await refresh(tokens.refresh_token);
    expect(retry.status).toBe(200);
    expect(await me(retry.body.access_token ?? "")).toBe(200);
    expect((await refresh(retry.body.refresh_token ?? "")).status).toBe(200);
  });

  it("a used refresh token presented after the grace window ends the session", async () => {
    const { tokens } = await signInCli(1, "octo");
    const next = await refresh(tokens.refresh_token);
    await db
      .update(schema.sessions)
      .set({ rotatedAt: new Date(Date.now() - REFRESH_GRACE_MS - 1000) });
    expect((await refresh(tokens.refresh_token)).body).toEqual({ error: "invalid_grant" });
    // Whoever holds the newer pair is signed out too.
    expect(await me(next.body.access_token ?? "")).toBe(401);
    expect((await refresh(next.body.refresh_token ?? "")).body).toEqual({ error: "invalid_grant" });
    expect(await cliSession()).toBeUndefined();
  });

  it("refreshing does not extend the session past 90 days from sign-in", async () => {
    const { tokens } = await signInCli(1, "octo");
    const end = new Date(Date.now() + 10 * 60_000);
    await db.update(schema.sessions).set({ refreshExpiresAt: end });
    const next = await refresh(tokens.refresh_token);
    expect(Number(next.body.expires_in)).toBeLessThanOrEqual(600);
    const row = await cliSession();
    expect(row?.refreshExpiresAt?.getTime()).toBe(end.getTime());
    expect(row?.expiresAt.getTime()).toBeLessThanOrEqual(end.getTime());
  });

  it("a CLI session is listed on the web until its refresh token expires, and can be revoked", async () => {
    const web = await signIn(1, "octo");
    const { tokens } = await signInCli(1, "octo");
    const list = (await (await call("/api/sessions", { headers: web.auth })).json()) as {
      sessions: { id: string; kind: string; label: string; expiresAt: string }[];
    };
    const cli = list.sessions.find((s) => s.kind === "cli");
    expect(cli?.label).toBe("test terminal");
    expect(new Date(cli?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);
    await call(`/api/sessions/${cli?.id}`, { method: "DELETE", headers: web.auth });
    const refresh = await post("/api/device/refresh", { refresh_token: tokens.refresh_token });
    expect(refresh.status).toBe(400);
  });

  it("answers denied, expired and unknown codes as RFC 8628 says", async () => {
    const me = await signIn(1, "octo");
    const denied = await startLogin();
    await post("/api/device/decide", { user_code: denied.user_code, approve: false }, me.auth);
    expect((await poll(denied.device_code)).body).toEqual({ error: "access_denied" });
    const again = await post(
      "/api/device/decide",
      { user_code: denied.user_code, approve: true },
      me.auth,
    );
    expect(again.status).toBe(409);

    const old = await startLogin();
    await db
      .update(schema.deviceCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.deviceCodes.userCode, old.user_code));
    expect((await poll(old.device_code)).body).toEqual({ error: "expired_token" });
    const info = await call(`/api/device/info?user_code=${old.user_code}`, { headers: me.auth });
    expect(info.status).toBe(404);

    expect((await poll("ocra_dev_nope")).body).toEqual({ error: "invalid_grant" });
  });

  it("slows down a CLI that polls faster than the interval", async () => {
    const code = await startLogin();
    await post("/api/device/token", { device_code: code.device_code });
    const fast = await post("/api/device/token", { device_code: code.device_code });
    expect(await fast.json()).toEqual({ error: "slow_down", interval: 10 });
  });

  it("needs a signed-in browser to see or approve a code", async () => {
    const code = await startLogin();
    expect((await call(`/api/device/info?user_code=${code.user_code}`)).status).toBe(401);
    expect(
      (await post("/api/device/decide", { user_code: code.user_code, approve: true })).status,
    ).toBe(401);
  });

  it("limits how many codes one address may request", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await post("/api/device/code", {}, { "cf-connecting-ip": "203.0.113.9" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(env.DEVICE_CODES).toBeDefined();
  });
});

describe("helpers", () => {
  it("normalizes typed user codes and refuses others", () => {
    expect(normalizeUserCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDF-GHJ")).toBeUndefined();
    expect(normalizeUserCode("ABCD-EFGH")).toBeUndefined();
  });

  it("returns only to relative paths on this site after sign-in", () => {
    expect(safeNext("/device?code=BCDF-GHJK")).toBe("/device?code=BCDF-GHJK");
    expect(safeNext("/reviews/1#findings")).toBe("/reviews/1#findings");
    for (const bad of [
      undefined,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "device",
      "/\t/evil.example/x",
      "/\n/evil.example/x",
      "/\r/evil.example/x",
      "/\u0000/evil.example",
      "/\u007f/evil.example",
      "/\t\\evil.example",
      "http://evil.example/x",
      "/".repeat(600),
    ]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});
