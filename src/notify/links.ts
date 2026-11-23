import { Hono } from "hono";
import { hmacHex, randomToken, sameText, sha256Hex } from "../crypto.js";
import { scoped } from "../db/scoped.js";
import { apiError } from "../http.js";
import type { AppEnv } from "../types.js";

// The two links an email carries, opened without signing in: confirming an
// added address (a random token, kept only as its hash, for a day) and
// unsubscribing it (signed, never expiring, one per channel). Each names
// its account and channel, so the lookup goes through scoped() like any
// other. A GET only shows a button: mail scanners open links, and must not
// confirm or unsubscribe by doing so; the button, or a mail client's
// one-click unsubscribe (RFC 8058), POSTs to the same address.

export const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;

const ID = "[A-Za-z0-9-]{1,64}";
const TOKEN = new RegExp(`^(${ID})\\.(${ID})\\.([A-Za-z0-9_-]{32,128})$`);

type Parts = { accountId: string; channelId: string; secret: string };

function partsOf(token: string | undefined): Parts | undefined {
  const m = token?.match(TOKEN);
  return m ? { accountId: m[1] ?? "", channelId: m[2] ?? "", secret: m[3] ?? "" } : undefined;
}

/** A new confirmation token for the channel, and the hash to keep. */
export async function confirmToken(accountId: string, channelId: string) {
  const secret = randomToken("");
  return { token: `${accountId}.${channelId}.${secret}`, hash: await sha256Hex(secret) };
}

const unsubscribeMac = (key: string, accountId: string, channelId: string) =>
  hmacHex(key, `ocra-unsubscribe:v1|${accountId}|${channelId}`);

export async function unsubscribeUrl(
  out: { linkSecret: string; origin: string },
  accountId: string,
  channelId: string,
): Promise<string> {
  const mac = await unsubscribeMac(out.linkSecret, accountId, channelId);
  return linkUrl(out.origin, "unsubscribe", `${accountId}.${channelId}.${mac}`);
}

export const linkUrl = (origin: string, what: "confirm" | "unsubscribe", token: string) =>
  `${origin}/api/email/${what}?t=${encodeURIComponent(token)}`;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

const button = (label: string) =>
  `<form method="post"><button type="submit">${label}</button></form>`;

export const emailLinks = new Hono<AppEnv>();

emailLinks.use(async (c, next) => {
  const { success } = await c.env.DEVICE_LOOKUPS.limit({ key: `email:${c.var.clientAddress}` });
  if (!success) return apiError(c, "slow_down", {}, 429);
  await next();
});

emailLinks.get("/confirm", (c) => {
  if (!partsOf(c.req.query("t"))) return apiError(c, "unknown_or_expired");
  return c.html(
    page(
      "Confirm this address",
      `<p>ocra will email this address about an account's reviews.</p>${button("Confirm")}`,
    ),
  );
});

emailLinks.post("/confirm", async (c) => {
  const parts = partsOf(c.req.query("t"));
  if (!parts) return apiError(c, "unknown_or_expired");
  const data = scoped(c.var.db, parts.accountId);
  const ok = await data.notify.confirm(parts.channelId, await sha256Hex(parts.secret), new Date());
  if (!ok) return apiError(c, "unknown_or_expired");
  return c.html(page("Address confirmed", "<p>This address now gets ocra's notifications.</p>"));
});

emailLinks.get("/unsubscribe", (c) => {
  if (!partsOf(c.req.query("t"))) return apiError(c, "unknown_or_expired");
  return c.html(
    page(
      "Unsubscribe",
      `<p>This address will get no more email from this ocra account.</p>${button("Unsubscribe")}`,
    ),
  );
});

/** Removes the channel. A link of a channel already gone answers the same, so it can be clicked twice. */
emailLinks.post("/unsubscribe", async (c) => {
  const parts = partsOf(c.req.query("t"));
  const expected =
    parts && (await unsubscribeMac(c.env.SESSION_SECRET, parts.accountId, parts.channelId));
  if (!parts || !expected || !sameText(expected, parts.secret)) {
    return apiError(c, "unknown_or_expired");
  }
  const data = scoped(c.var.db, parts.accountId);
  const channel = await data.get("notifyChannels", parts.channelId);
  if (channel?.kind === "email") {
    await data.remove("notifyChannels", channel.id);
    await data.deliveries.drop([channel.id]);
  }
  return c.html(page("Unsubscribed", "<p>This address gets no more email from this account.</p>"));
});
