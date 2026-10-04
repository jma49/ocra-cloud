import { Hono } from "hono";
import { refreshCliSession, requireSession, startCliSession } from "./auth.js";
import { randomToken, sha256Hex } from "./crypto.js";
import {
  byDeviceCodeHash,
  byUserCode,
  consume,
  createDeviceCode,
  decide,
  recordPoll,
} from "./db/device.js";
import type { AppEnv } from "./types.js";

// `ocra login`: the OAuth 2.0 device authorization grant (RFC 8628). The CLI
// asks for a code, the user approves it on the web while signed in, and the
// CLI's polling then receives a CLI session's tokens.

const CODE_TTL_MS = 10 * 60_000;
const INTERVAL = 5;
// No vowels or look-alikes, so a code is never a word and is easy to read out.
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export const device = new Hono<AppEnv>();

function newUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normalizeUserCode(input: string): string | undefined {
  const s = input.toUpperCase().replace(/[^A-Z]/g, "");
  if (s.length !== 8 || [...s].some((ch) => !ALPHABET.includes(ch))) return undefined;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

device.post("/code", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.DEVICE_CODES.limit({ key: ip });
  if (!success) return c.json({ error: "slow_down" }, 429);
  const body = (await c.req.json().catch(() => ({}))) as { client_name?: unknown };
  const label =
    typeof body.client_name === "string"
      ? body.client_name.slice(0, 80).replace(/[^\w .@()-]/g, "")
      : null;
  const deviceCode = randomToken("ocra_dev_");
  const userCode = newUserCode();
  await createDeviceCode(c.var.db, {
    deviceCodeHash: await sha256Hex(deviceCode),
    userCode,
    label: label || null,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  const verify = new URL("/device", c.req.url);
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verify.toString(),
    verification_uri_complete: `${verify}?code=${userCode}`,
    expires_in: CODE_TTL_MS / 1000,
    interval: INTERVAL,
  });
});

// The web page shows what is being approved: the terminal's name and when it asked.
device.get("/info", requireSession(), async (c) => {
  const code = normalizeUserCode(c.req.query("user_code") ?? "");
  const row = code ? await byUserCode(c.var.db, code) : undefined;
  if (!row || row.expiresAt < new Date() || row.status !== "pending") {
    return c.json({ error: "unknown_or_expired" }, 404);
  }
  return c.json({ user_code: row.userCode, label: row.label, createdAt: row.createdAt });
});

device.post("/decide", requireSession(), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { user_code?: unknown; approve?: unknown };
  const code = typeof body.user_code === "string" ? normalizeUserCode(body.user_code) : undefined;
  const row = code ? await byUserCode(c.var.db, code) : undefined;
  if (!row || row.expiresAt < new Date()) return c.json({ error: "unknown_or_expired" }, 404);
  const approve = body.approve === true;
  const ok = await decide(c.var.db, row.id, approve, c.var.session.account.id);
  if (!ok) return c.json({ error: "already_decided" }, 409);
  return c.json({ approved: approve });
});

// Polled by the CLI. Errors follow RFC 8628 section 3.5.
device.post("/token", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { device_code?: unknown };
  if (typeof body.device_code !== "string") return c.json({ error: "invalid_request" }, 400);
  const row = await byDeviceCodeHash(c.var.db, await sha256Hex(body.device_code));
  if (!row) return c.json({ error: "invalid_grant" }, 400);
  const now = new Date();
  if (row.expiresAt < now) return c.json({ error: "expired_token" }, 400);
  if (row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < row.intervalSeconds * 1000) {
    await recordPoll(c.var.db, row.id, now, row.intervalSeconds + 5);
    return c.json({ error: "slow_down", interval: row.intervalSeconds + 5 }, 400);
  }
  await recordPoll(c.var.db, row.id, now, row.intervalSeconds);
  if (row.status === "pending") return c.json({ error: "authorization_pending" }, 400);
  if (row.status === "denied") return c.json({ error: "access_denied" }, 400);
  if (row.status === "consumed" || !row.approvedAccountId)
    return c.json({ error: "invalid_grant" }, 400);
  if (!(await consume(c.var.db, row.id))) return c.json({ error: "invalid_grant" }, 400);
  return c.json(await startCliSession(c.var.db, row.approvedAccountId, row.label ?? "Terminal"));
});

device.post("/refresh", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { refresh_token?: unknown };
  if (typeof body.refresh_token !== "string") return c.json({ error: "invalid_request" }, 400);
  const tokens = await refreshCliSession(c.var.db, body.refresh_token);
  if (!tokens) return c.json({ error: "invalid_grant" }, 400);
  return c.json(tokens);
});
