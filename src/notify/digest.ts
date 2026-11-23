import { type CallBudget, uncapped } from "../calls.js";
import type { Db } from "../db/client.js";
import type { MergedPull } from "../db/closed-pulls.js";
import { type DigestNumbers, digestAccounts } from "../db/notify.js";
import { scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { NOTIFY_WHEN, type NotifyWhen } from "../shared/index.js";
import { DAY, utcDay, utcDayStart } from "../time.js";
import { type Message, plain, whensFor } from "./channels.js";
import { type Outbox, send } from "./notify.js";

// The daily digest: yesterday's reviews and merges (UTC) of each account with a
// channel that takes it, sent once per account and day whichever host and
// process runs it, and however often (the Worker's cron, the Node server's
// timer). The day is claimed before anything is sent, so it is made once;
// each channel's delivery of it is retried like any message
// (./deliveries.ts).

const ACCOUNTS_AT_ONCE = 4;
/** Merged pull requests a digest names. */
const MERGED_TITLES = 5;

export type Merges = { merged: number; newest: MergedPull[] };

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Every account's run of fn, a few at a time, while `calls` has room for
 * one more: the accounts after wait for the next run, their work not
 * claimed. One that fails is logged as event and the rest still go.
 */
export async function forAccounts<T>(
  accounts: readonly T[],
  event: string,
  fn: (account: T) => Promise<unknown>,
  calls: CallBudget = uncapped(),
): Promise<void> {
  for (let i = 0; i < accounts.length && calls.has(); i += ACCOUNTS_AT_ONCE) {
    await Promise.all(
      accounts
        .slice(i, i + ACCOUNTS_AT_ONCE)
        .map((a) => fn(a).catch((e) => logError(event, { error: errorName(e) }))),
    );
  }
}

/**
 * The settings of `when` that get a digest or report: every one when it
 * names merges, else those that hear about one of its reviews.
 */
export const periodWhens = (n: DigestNumbers, m: Merges): readonly NotifyWhen[] =>
  m.merged > 0 ? NOTIFY_WHEN : whensFor({ critical: n.blocking, findings: n.withFindings });

/** The lines naming the merged pull requests, newest first. */
export const mergedLines = (m: Merges): string[][] =>
  m.newest.map((p) => [`• ${plain(p.repo)}#${p.number} ${plain(p.title)}`]);

function digestMessage(day: string, n: DigestNumbers, m: Merges, origin: string): Message {
  const pulls = n.pulls > 0 ? ` of ${plural(n.pulls, "pull request")}` : "";
  const reviews = `${plural(n.reviews, "review")}${pulls}`;
  return {
    event: "digest",
    subject: `ocra digest for ${day}: ${reviews}, ${n.critical} critical, ${m.merged} merged`,
    lines: [
      [`ocra's digest for ${day} (UTC): ${reviews}`],
      [`${n.critical} critical · ${n.warning} warning · ${n.suggestion} suggestion`],
      ...(n.open.length > 0 ? [["Still open:"]] : []),
      ...n.open.map((f) => [`• ${f.severity}: ${plain(f.title)} (${plain(f.file)})`]),
      ...(m.merged > 0 ? [[`Merged: ${plural(m.merged, "pull request")}`], ...mergedLines(m)] : []),
      [
        { label: "Reviews", url: `${origin}/reviews` },
        " · ",
        { label: "Findings", url: `${origin}/findings` },
      ],
    ],
  };
}

/** Sends one account's digest of the day before now's, unless it went already; whether it was sent. */
async function sendDigest(
  db: Db,
  out: Outbox,
  accountId: string,
  now = new Date(),
): Promise<boolean> {
  const to = utcDayStart(now);
  const from = new Date(to.getTime() - DAY);
  const day = utcDay(from);
  const data = scoped(db, accountId);
  const claimed = await data.notify.claimDigest(day);
  if (!claimed) return false;
  const [numbers, merges] = await Promise.all([
    data.notify.digestOf(from, to, claimed.shareFindings),
    data.closedPulls.mergedBetween(from, to, MERGED_TITLES),
  ]);
  // A day without reviews or merges says nothing worth an email.
  if (numbers.reviews === 0 && merges.merged === 0) return false;
  const whens = periodWhens(numbers, merges);
  const channels = await data.notify.digesting(whens);
  const m = { ...digestMessage(day, numbers, merges, out.origin), whens };
  await Promise.all(channels.map((ch) => send(data, out, ch, m)));
  return channels.length > 0;
}

/** Every account's digest; one that fails is logged and the rest still go. */
export async function runDigests(
  db: Db,
  out: Outbox,
  now = new Date(),
  calls?: CallBudget,
): Promise<void> {
  await forAccounts(
    await digestAccounts(db),
    "digest_failed",
    (id) => sendDigest(db, out, id, now),
    calls,
  );
}
