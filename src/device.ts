import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  deviceCodeRequestSchema,
  deviceTokenRequestSchema,
  refreshRequestSchema,
} from "./contract/index.js";
import { randomToken, sha256Hex } from "./crypto.js";
import {
  byDeviceCodeHash,
  byUserCode,
  consume,
  createDeviceCode,
  decide,
  recordPoll,
} from "./db/device.js";
import { apiError, jsonBody } from "./http.js";
import {
  refreshCliSession,
  reissueCliSession,
  requireSession,
  startCliSession,
} from "./session.js";
import type { AppEnv } from "./types.js";

// `ocra login`: the OAuth 2.0 device authorization grant (RFC 8628). The CLI
// asks for a code, the user approves it on the web while signed in, and the
// CLI's polling then receives a CLI session's tokens.

const CODE_TTL_MS = 10 * 60_000;
const INTERVAL = 5;
// No vowels or look-alikes, so a code is never a word and is easy to read out.
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export const device = new Hono<AppEnv>();

type RandomBytes = (n: number) => Uint8Array;
const randomBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * Eight letters, each equally likely: a byte at or above the largest
 * multiple of the alphabet's size is drawn again (rejection sampling), as
 * `byte % 20` alone favours the first 16 letters.
 */
export function newUserCode(random: RandomBytes = randomBytes): string {
  const bound = 256 - (256 % ALPHABET.length);
  let chars = "";
  while (chars.length < 8) {
    for (const b of random(8)) {
      if (b < bound && chars.length < 8) chars += ALPHABET[b % ALPHABET.length];
    }
  }
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * Code lookups and decisions per minute, for the account and for the
 * address, so a signed-in user cannot walk the code space.
 */
const limitLookups: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  for (const key of [`account:${c.var.session.account.id}`, `ip:${ip}`]) {
    const { success } = await c.env.DEVICE_LOOKUPS.limit({ key });
    if (!success) return apiError(c, "slow_down", {}, 429);
  }
  await next();
};

export function normalizeUserCode(input: string): string | undefined {
  const s = input.toUpperCase().replace(/[^A-Z]/g, "");
  if (s.length !== 8 || [...s].some((ch) => !ALPHABET.includes(ch))) return undefined;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// Any body, or none: the name only labels the session on the web.
const codeRequest = deviceCodeRequestSchema.catch({});
// What the web sends to approve or deny a code; the code itself is looked up.
const decideRequest = z.object({ user_code: z.string(), approve: z.boolean() });
const RFC_INVALID = { invalid: "invalid_request" } as const;

device.post("/code", jsonBody(codeRequest), async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.DEVICE_CODES.limit({ key: ip });
  if (!success) return apiError(c, "slow_down", {}, 429);
  const name = c.req.valid("json").client_name;
  const label = name === undefined ? null : name.slice(0, 80).replace(/[^\w .@()-]/g, "");
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
device.get("/info", requireSession(), limitLookups, async (c) => {
  const code = normalizeUserCode(c.req.query("user_code") ?? "");
  const row = code ? await byUserCode(c.var.db, code) : undefined;
  if (!row || row.expiresAt < new Date() || row.status !== "pending") {
    return apiError(c, "unknown_or_expired");
  }
  return c.json({ user_code: row.userCode, label: row.label, createdAt: row.createdAt });
});

device.post("/decide", requireSession(), limitLookups, jsonBody(decideRequest), async (c) => {
  const body = c.req.valid("json");
  const code = normalizeUserCode(body.user_code);
  const row = code ? await byUserCode(c.var.db, code) : undefined;
  if (!row || row.expiresAt < new Date()) return apiError(c, "unknown_or_expired");
  const approve = body.approve;
  const ok = await decide(c.var.db, row.id, approve, c.var.session.account.id);
  if (!ok) return apiError(c, "already_decided");
  return c.json({ approved: approve });
});

// Polled by the CLI. Errors follow RFC 8628 section 3.5.
device.post("/token", jsonBody(deviceTokenRequestSchema, RFC_INVALID), async (c) => {
  const body = c.req.valid("json");
  const row = await byDeviceCodeHash(c.var.db, await sha256Hex(body.device_code));
  if (!row) return apiError(c, "invalid_grant");
  const now = new Date();
  if (row.expiresAt < now) return apiError(c, "expired_token");
  if (row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < row.intervalSeconds * 1000) {
    await recordPoll(c.var.db, row.id, now, row.intervalSeconds + 5);
    return apiError(c, "slow_down", { interval: row.intervalSeconds + 5 });
  }
  await recordPoll(c.var.db, row.id, now, row.intervalSeconds);
  if (row.status === "pending") return apiError(c, "authorization_pending");
  if (row.status === "denied") return apiError(c, "access_denied");
  if (!row.approvedAccountId) return apiError(c, "invalid_grant");
  // The session takes the code's id, so a poll whose answer was lost can
  // find it again: within a minute, and while its tokens are unused, the
  // next poll gets a new pair for the same session (audit K-device).
  if (row.status === "consumed" || !(await consume(c.var.db, row.id))) {
    const again = await reissueCliSession(c.var.db, row.approvedAccountId, row.id, now);
    return again ? c.json(again) : apiError(c, "invalid_grant");
  }
  return c.json(
    await startCliSession(c.var.db, row.approvedAccountId, row.label ?? "Terminal", row.id),
  );
});

device.post("/refresh", jsonBody(refreshRequestSchema, RFC_INVALID), async (c) => {
  const tokens = await refreshCliSession(c.var.db, c.req.valid("json").refresh_token);
  if (!tokens) return apiError(c, "invalid_grant");
  return c.json(tokens);
});
