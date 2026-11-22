import { decryptWithAny, encryptSecret, type MasterKeys } from "../crypto.js";
import type { Row, Scoped } from "../db/scoped.js";
import type { CodePlatform } from "../platforms/platform.js";
import { platformOfPull, pullOfReview, pullPageUrl } from "../review-pull.js";

import { deliver, messageOf, type ReviewNotice, whensFor } from "./channels.js";

// Announcing a stored review in the account's chats: each channel whose
// setting takes it gets one message, and keeps how that went. A channel
// whose address no longer decrypts counts as failed; nothing is retried.

const binding = (accountId: string, channelId: string) =>
  `ocra-notify-channel:v1|${accountId}|${channelId}`;

/** The webhook address sealed to its channel's row. */
export const sealHook = (masterKey: string, accountId: string, channelId: string, url: string) =>
  encryptSecret(masterKey, url, binding(accountId, channelId));

async function openHook(keys: MasterKeys, channel: Row<"notifyChannels">) {
  try {
    return await decryptWithAny(keys, channel, binding(channel.accountId, channel.id));
  } catch {
    return undefined;
  }
}

/** Sends the message to the channel and records how it went; whether the chat took it. */
export async function send(
  data: Scoped,
  keys: MasterKeys,
  channel: Row<"notifyChannels">,
  body: unknown,
): Promise<boolean> {
  const url = await openHook(keys, channel);
  const ok = url !== undefined && (await deliver(channel.kind, url, body));
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
  const pull = pullOfReview(review);
  const platform = pull && platformOfPull(platforms, pull);
  const findings = await data.findingsOf(review.id);
  return {
    pull:
      pull && platform
        ? { label: `${pull.repo}#${pull.number}`, url: pullPageUrl(platform, pull) }
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

/** Announces the review in each of the account's channels that takes it. */
export async function notifyReview(
  data: Scoped,
  keys: MasterKeys,
  review: Row<"reviews">,
  platforms: readonly CodePlatform[],
  consoleUrl: string,
): Promise<void> {
  const channels = (
    await Promise.all(whensFor(review).map((when) => data.find("notifyChannels", { when })))
  ).flat();
  if (channels.length === 0) return;
  const notice = await noticeOf(data, review, platforms, consoleUrl);
  await Promise.all(channels.map((ch) => send(data, keys, ch, messageOf(ch.kind, notice))));
}
