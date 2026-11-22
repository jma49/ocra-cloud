import type { Context } from "hono";
import { decryptWithAny, encryptSecret, type MasterKeys } from "../crypto.js";
import type { Row, Scoped } from "../db/scoped.js";
import { masterKeys } from "../keyring.js";
import type { CodePlatform } from "../platforms/platform.js";
import { pullOfReview, pullOnPlatform, pullPageUrl } from "../review-pull.js";
import type { AppEnv } from "../types.js";
import {
  deliver,
  type Message,
  messageOf,
  type ReviewNotice,
  reviewMessage,
  whensFor,
} from "./channels.js";
import { type Mailer, mailOf, sendMail } from "./email.js";
import { unsubscribeUrl } from "./links.js";

// Announcing a stored review in the account's chats and confirmed email
// addresses: each channel whose setting takes it gets one message, and
// keeps how that went. A channel whose address no longer decrypts counts as
// failed; nothing is retried.

/** What sending needs from the host: the keys, its mailer if it has one, and its links. */
export type Outbox = {
  keys: MasterKeys;
  mailer: Mailer | undefined;
  /** Signs the unsubscribe links (SESSION_SECRET). */
  linkSecret: string;
  /** The console's origin, which the links point to. */
  origin: string;
};

/** The outbox of a request: its links point to the origin it came to. */
export const outboxOf = (c: Context<AppEnv>): Outbox => ({
  keys: masterKeys(c.env),
  mailer: c.var.mailer,
  linkSecret: c.env.SESSION_SECRET,
  origin: new URL(c.req.url).origin,
});

/** The outbox of a request whose links point to PUBLIC_URL where it is set (a webhook's). */
export function publicOutbox(c: Context<AppEnv>): Outbox {
  const out = outboxOf(c);
  return c.env.PUBLIC_URL ? { ...out, origin: new URL(c.env.PUBLIC_URL).origin } : out;
}

const binding = (accountId: string, channelId: string) =>
  `ocra-notify-channel:v1|${accountId}|${channelId}`;

/** The webhook or email address sealed to its channel's row. */
export const sealHook = (masterKey: string, accountId: string, channelId: string, url: string) =>
  encryptSecret(masterKey, url, binding(accountId, channelId));

export async function openHook(keys: MasterKeys, channel: Row<"notifyChannels">) {
  try {
    return await decryptWithAny(keys, channel, binding(channel.accountId, channel.id));
  } catch {
    return undefined;
  }
}

async function deliverTo(
  out: Outbox,
  channel: Row<"notifyChannels">,
  address: string,
  m: Message,
): Promise<boolean> {
  if (channel.kind !== "email") return deliver(channel.kind, address, messageOf(channel.kind, m));
  if (!out.mailer || !channel.confirmedAt) return false;
  const unsubscribe = await unsubscribeUrl(out, channel.accountId, channel.id);
  return sendMail(out.mailer, mailOf(m, address, unsubscribe));
}

/** Sends the message to the channel and records how it went; whether it was taken. */
export async function send(
  data: Scoped,
  out: Outbox,
  channel: Row<"notifyChannels">,
  m: Message,
): Promise<boolean> {
  const address = await openHook(out.keys, channel);
  const ok = address !== undefined && (await deliverTo(out, channel, address, m));
  await data.batch((w) => [
    w.update("notifyChannels", channel.id, {
      lastStatus: ok ? "ok" : "failed",
      lastSentAt: new Date(),
    }),
  ]);
  return ok;
}

const SEVERE = { critical: 0, warning: 1 } as Record<string, number>;

/** The notice of a stored review: its counts, its pull request, its most severe findings. */
async function noticeOf(
  data: Scoped,
  review: Row<"reviews">,
  platforms: readonly CodePlatform[],
  consoleUrl: string,
): Promise<ReviewNotice> {
  const reviewed = pullOfReview(review);
  const on = reviewed && pullOnPlatform(platforms, reviewed);
  const findings = await data.findingsOf(review.id);
  return {
    pull: on
      ? { label: `${on.pull.repo}#${on.pull.number}`, url: pullPageUrl(on.platform, on.pull) }
      : null,
    critical: review.critical,
    warning: review.warning,
    suggestion: review.suggestion,
    verdict: review.verdict,
    complete: review.complete,
    titles: findings
      .filter((f) => f.severity in SEVERE)
      .sort((a, b) => (SEVERE[a.severity] ?? 2) - (SEVERE[b.severity] ?? 2))
      .slice(0, 3)
      .map((f) => ({ title: f.title, file: f.file })),
    consoleUrl,
  };
}

/** Announces the review in each of the account's confirmed channels that takes it, but those told already. */
export async function notifyReview(
  data: Scoped,
  out: Outbox,
  review: Row<"reviews">,
  platforms: readonly CodePlatform[],
  consoleUrl: string,
  told: readonly string[] = [],
): Promise<void> {
  const channels = (await data.notify.listening(whensFor(review))).filter(
    (ch) => !told.includes(ch.id),
  );
  if (channels.length === 0) return;
  const m = reviewMessage(await noticeOf(data, review, platforms, consoleUrl));
  await Promise.all(channels.map((ch) => send(data, out, ch, m)));
}
