import type { Context } from "hono";
import { decryptWithAny, encryptSecret, type MasterKeys } from "../crypto.js";
import type { Db } from "../db/client.js";
import type { Row, Scoped } from "../db/scoped.js";
import { masterKeys } from "../keyring.js";
import { consolePullUrl } from "../merge-checks/run.js";
import type { CodePlatform } from "../platforms/platform.js";
import { pullOfReview, pullOnPlatform, pullPageUrl } from "../review-pull.js";
import type { AppEnv } from "../types.js";
import {
  chatAttempt,
  type Message,
  messageOf,
  plain,
  type ReviewNotice,
  reviewMessage,
  whensFor,
} from "./channels.js";
import { type Attempt, deliver, type Outgoing, REFUSED, retryDeliveries } from "./deliveries.js";
import { type Mailer, mailAttempt, mailBody } from "./email.js";
import { unsubscribeUrl } from "./links.js";
import {
  fetchWebhook,
  type HookEvent,
  hookOutgoing,
  type WebhookPost,
  type WebhookTarget,
  webhookAttempt,
} from "./webhooks.js";

// Announcing a stored review in the account's chats and confirmed email
// addresses: each channel whose setting takes it gets one message, and
// keeps how that went. Every message, of every kind, goes through the
// channel's delivery queue (./deliveries.ts), which retries what failed for
// a reason that may pass; a channel whose address no longer decrypts is
// refused.

/** What sending needs from the host: the keys, its mailer if it has one, and its links. */
export type Outbox = {
  keys: MasterKeys;
  mailer: Mailer | undefined;
  /** Signs the unsubscribe links (SESSION_SECRET). */
  linkSecret: string;
  /** The console's origin, which the links point to. */
  origin: string;
  /** How webhooks are posted; fetch where the host gives none. */
  webhooks?: WebhookPost | undefined;
};

/** The outbox of a request: its links point to the origin it came to. */
export const outboxOf = (c: Context<AppEnv>): Outbox => ({
  keys: masterKeys(c.env),
  mailer: c.var.mailer,
  linkSecret: c.env.SESSION_SECRET,
  origin: new URL(c.req.url).origin,
  webhooks: c.var.webhookPost,
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

/** A webhook channel's address and signing secret, sealed together. */
export const sealWebhook = (
  masterKey: string,
  accountId: string,
  channelId: string,
  target: WebhookTarget,
) => sealHook(masterKey, accountId, channelId, JSON.stringify(target));

export async function openWebhook(
  keys: MasterKeys,
  channel: Row<"notifyChannels">,
): Promise<WebhookTarget | undefined> {
  const sealed = await openHook(keys, channel);
  if (sealed === undefined) return undefined;
  try {
    const t = JSON.parse(sealed) as Partial<WebhookTarget>;
    return typeof t.url === "string" && typeof t.secret === "string"
      ? { url: t.url, secret: t.secret }
      : undefined;
  } catch {
    return undefined;
  }
}

/** What sending needs to make an attempt: the keys, the mailer, how webhooks are posted. */
export type Transports = Pick<Outbox, "keys" | "mailer" | "webhooks">;

/**
 * How the channel is sent to, its address opened again for each send and
 * retry: one that no longer opens, or an email channel on a host without
 * a mailer, is refused.
 */
async function attemptOn(out: Transports, channel: Row<"notifyChannels">): Promise<Attempt> {
  if (channel.kind === "webhook") {
    const target = await openWebhook(out.keys, channel);
    return target ? webhookAttempt(out.webhooks ?? fetchWebhook, target) : refused;
  }
  const address = await openHook(out.keys, channel);
  if (address === undefined) return refused;
  if (channel.kind !== "email") return chatAttempt(channel.kind, address);
  return out.mailer && channel.confirmedAt ? mailAttempt(out.mailer, address) : refused;
}

const refused: Attempt = async () => REFUSED;

/** Tries again every account's deliveries due; how many it tried. */
export const retryNotifications = (db: Db, out: Transports, now?: () => Date) =>
  retryDeliveries(db, (channel) => attemptOn(out, channel), now);

/** What the channel's kind is sent: a webhook's events, or the message as its medium shows it. */
async function outgoingOf(
  out: Outbox,
  channel: Row<"notifyChannels">,
  m: Message,
): Promise<Outgoing[]> {
  if (channel.kind === "webhook") return (m.hooks ?? []).map(hookOutgoing);
  if (channel.kind !== "email") {
    const body = JSON.stringify(messageOf(channel.kind, m));
    return [{ event: m.event, payload: () => body }];
  }
  const unsubscribe = await unsubscribeUrl(out, channel.accountId, channel.id);
  const body = JSON.stringify(mailBody(m, unsubscribe));
  return [{ event: m.event, payload: () => body }];
}

/**
 * Sends the message to the channel through its delivery queue and records
 * how its first attempt went; whether every delivery was taken at once.
 */
export async function send(
  data: Scoped,
  out: Outbox,
  channel: Row<"notifyChannels">,
  m: Message,
): Promise<boolean> {
  // A digest, report or held notice has no webhook event; a webhook channel never takes one.
  if (channel.kind === "webhook" && !m.hooks?.length) return false;
  // A server without a mailer, or an address not confirmed, has nothing to deliver.
  if (channel.kind === "email" && (!out.mailer || !channel.confirmedAt)) return false;
  const ok = await deliver(
    data,
    channel,
    await attemptOn(out, channel),
    await outgoingOf(out, channel, m),
  );
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

const SEVERITIES = ["critical", "warning", "suggestion"] as const;
const severityOf = (s: string) => SEVERITIES.find((v) => v === s);

/** The review's webhook event; finding titles only when the account shares findings. */
async function reviewHook(
  data: Scoped,
  out: Outbox,
  review: Row<"reviews">,
  platforms: readonly CodePlatform[],
  consoleUrl: string,
  share: boolean,
): Promise<HookEvent> {
  const reviewed = pullOfReview(review);
  const on = reviewed && pullOnPlatform(platforms, reviewed);
  const findings = share
    ? (await data.findingsOf(review.id)).flatMap((f) => {
        const severity = severityOf(f.severity);
        return severity ? [{ severity, title: plain(f.title), file: f.file }] : [];
      })
    : undefined;
  return {
    event: "review_completed",
    data: {
      review: {
        id: review.id,
        consoleUrl,
        verdict: review.verdict,
        complete: review.complete,
        critical: review.critical,
        warning: review.warning,
        suggestion: review.suggestion,
      },
      pull: on
        ? {
            platform: on.platform.kind,
            repo: on.pull.repo,
            number: on.pull.number,
            consoleUrl: consolePullUrl(
              out.origin,
              { platform: on.platform.kind, fullName: on.pull.repo },
              on.pull.number,
            ),
          }
        : null,
      ...(findings ? { findings: findings.slice(0, MAX_HOOK_FINDINGS) } : {}),
    },
  };
}

const MAX_HOOK_FINDINGS = 50;

/** Announces the review in each of the account's confirmed channels that takes it, but those told already. */
export async function notifyReview(
  data: Scoped,
  out: Outbox,
  review: Row<"reviews">,
  platforms: readonly CodePlatform[],
  consoleUrl: string,
  told: readonly string[] = [],
  share = false,
): Promise<void> {
  const channels = (await data.notify.listening(whensFor(review))).filter(
    (ch) => !told.includes(ch.id),
  );
  if (channels.length === 0) return;
  const m = reviewMessage(await noticeOf(data, review, platforms, consoleUrl));
  if (channels.some((ch) => ch.kind === "webhook")) {
    m.hooks = [await reviewHook(data, out, review, platforms, consoleUrl, share)];
  }
  await Promise.all(channels.map((ch) => send(data, out, ch, m)));
}
