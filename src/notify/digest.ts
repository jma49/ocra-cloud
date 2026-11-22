import type { Db } from "../db/client.js";
import { type DigestNumbers, digestAccounts } from "../db/notify.js";
import { scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { DAY, utcDay, utcDayStart } from "../time.js";
import { type Message, plain } from "./channels.js";
import { type Outbox, send } from "./notify.js";

// The daily digest: yesterday's reviews (UTC) of each account with a
// channel that takes it, sent once per account and day whichever host and
// process runs it, and however often (the Worker's cron, the Node server's
// timer). The day is claimed before anything is sent, so a send that fails
// is not retried: the digest is a summary, not a record.

const ACCOUNTS_AT_ONCE = 4;

function digestMessage(day: string, n: DigestNumbers, origin: string): Message {
  const pulls = n.pulls > 0 ? ` of ${n.pulls} pull request${n.pulls === 1 ? "" : "s"}` : "";
  const reviews = `${n.reviews} review${n.reviews === 1 ? "" : "s"}${pulls}`;
  return {
    subject: `ocra digest for ${day}: ${reviews}, ${n.critical} critical`,
    lines: [
      [`ocra's digest for ${day} (UTC): ${reviews}`],
      [`${n.critical} critical · ${n.warning} warning · ${n.suggestion} suggestion`],
      ...(n.open.length > 0 ? [["Still open:"]] : []),
      ...n.open.map((f) => [`• ${f.severity}: ${plain(f.title)} (${plain(f.file)})`]),
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
  const numbers = await data.notify.digestOf(from, to, claimed.shareFindings);
  // A day without reviews says nothing worth an email.
  if (numbers.reviews === 0) return false;
  const channels = await data.notify.digesting();
  const m = digestMessage(day, numbers, out.origin);
  await Promise.all(channels.map((ch) => send(data, out, ch, m)));
  return channels.length > 0;
}

/** Every account's digest; one that fails is logged and the rest still go. */
export async function runDigests(db: Db, out: Outbox, now = new Date()): Promise<void> {
  const accounts = await digestAccounts(db);
  for (let i = 0; i < accounts.length; i += ACCOUNTS_AT_ONCE) {
    await Promise.all(
      accounts
        .slice(i, i + ACCOUNTS_AT_ONCE)
        .map((id) =>
          sendDigest(db, out, id, now).catch((e) =>
            logError("digest_failed", { error: errorName(e) }),
          ),
        ),
    );
  }
}
