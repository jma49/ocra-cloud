import { githubIdOf } from "../db/accounts.js";
import type { Db } from "../db/client.js";
import { reminderAccounts } from "../db/notify.js";
import type { PlatformUser, Waiting } from "../db/review-requests.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import { consolePullUrl } from "../merge-checks/run.js";
import { type NotifyEvent, REMINDER_EVENTS } from "../shared/index.js";
import { HOUR } from "../time.js";
import { type Message, plain } from "./channels.js";
import { forAccounts, plural } from "./digest.js";
import { type Outbox, send } from "./notify.js";
import { span } from "./report.js";

// Review reminders, from the hourly run: a review asked of the account's own
// platform user that still waits (review_waiting), and a pull request they
// wrote that no one has reviewed (pull_waiting), on its enrolled
// repositories, once it has waited a channel's reminderHours. Only what the
// webhooks stored is read. Each channel claims each reminder by its key (the
// pull request and when it started waiting) before one message lists all it
// claimed, so a reminder goes once whichever host and process runs it, and a
// new ask after a review is a new one. Quiet hours hold reminders until
// they end; a wait older than WINDOW is never a reminder, so a key's claim
// (kept 30 days) outlives it.

const WINDOW = 7 * 24 * HOUR;
/** Waiting pull requests read per user and kind. */
const READ = 25;
/** Pull requests a message names per kind. */
const LISTED = 10;

type Reminder = { kind: NotifyEvent; key: string; w: Waiting };

/** The time zone as the runtime names it, or undefined when it knows none of that name. */
export function timeZoneOf(text: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: text }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** The hour of the day (0-23) at now in timeZone. */
export function hourIn(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZoneOf(timeZone) ?? "UTC",
    hour: "numeric",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .find((p) => p.type === "hour")?.value;
  return Number(hour ?? 0) % 24;
}

/** Whether hour is in the channel's quiet hours. */
export function isQuiet(ch: Pick<Row<"notifyChannels">, "quietStart" | "quietEnd">, hour: number) {
  const { quietStart: start, quietEnd: end } = ch;
  if (start === null || end === null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** The account's own users on its platforms: its GitHub sign-in, the users of its GitLab links. */
async function ownUsers(db: Db, data: Scoped): Promise<PlatformUser[]> {
  const users: PlatformUser[] = [];
  const github = await githubIdOf(db, data.accountId);
  if (github !== null)
    users.push({ platform: "github", host: "github.com", userId: String(github) });
  for (const link of await data.find("platformLinks", { platform: "gitlab" }, 20)) {
    if (link.userId) users.push({ platform: "gitlab", host: link.host, userId: link.userId });
  }
  return users;
}

function lines(title: string, list: Reminder[], now: Date, origin: string) {
  if (list.length === 0) return [];
  const shown = list.slice(0, LISTED).map(({ w }) => [
    "• ",
    {
      label: `${w.repo}#${w.number}`,
      url: consolePullUrl(origin, { platform: w.platform, fullName: w.repo }, w.number),
    },
    `${w.title ? ` ${plain(w.title)}` : ""} · waiting ${span(now.getTime() - w.since)}`,
  ]);
  const more = list.length > LISTED ? [[`… and ${list.length - LISTED} more`]] : [];
  return [[`${title} (${list.length}):`], ...shown, ...more];
}

function reminderMessage(list: Reminder[], now: Date, origin: string): Message {
  const review = list.filter((r) => r.kind === "review_waiting");
  const own = list.filter((r) => r.kind === "pull_waiting");
  return {
    subject: `ocra: ${plural(list.length, "pull request")} waiting`,
    lines: [
      ...lines("Waiting for your review", review, now, origin),
      ...lines("Your pull requests waiting for a review", own, now, origin),
    ],
  };
}

/** The reminders due now for any of channels, before each channel's own hours. */
async function dueReminders(
  db: Db,
  data: Scoped,
  channels: Row<"notifyChannels">[],
  now: Date,
): Promise<Reminder[]> {
  const hears = (kind: NotifyEvent) => channels.some((ch) => ch.events.includes(kind));
  const least = Math.min(...channels.map((ch) => ch.reminderHours ?? Infinity));
  const from = new Date(now.getTime() - WINDOW);
  const to = new Date(now.getTime() - least * HOUR);
  const found: Reminder[] = [];
  for (const u of await ownUsers(db, data)) {
    if (hears("review_waiting")) {
      for (const w of await data.reviewRequests.askedOf(u, from, to, READ)) {
        const key = `reminder:review:${w.reviewRepoId}#${w.number}:${u.userId}:${w.since}`;
        found.push({ kind: "review_waiting", key, w });
      }
    }
    if (hears("pull_waiting")) {
      for (const w of await data.reviewRequests.unreviewedOf(u, from, to, READ)) {
        found.push({
          kind: "pull_waiting",
          key: `reminder:pull:${w.reviewRepoId}#${w.number}:${w.since}`,
          w,
        });
      }
    }
  }
  return found;
}

/** Sends one account's due reminders, one message per channel; the channels told. */
async function sendReminders(
  db: Db,
  out: Outbox,
  accountId: string,
  now = new Date(),
): Promise<string[]> {
  const data = scoped(db, accountId);
  const all = (await data.notify.reminding()).filter((ch) =>
    ch.events.some((e) => (REMINDER_EVENTS as readonly NotifyEvent[]).includes(e)),
  );
  if (all.length === 0) return [];
  const hour = hourIn(now, await data.notify.timeZone());
  const channels = all.filter((ch) => !isQuiet(ch, hour));
  if (channels.length === 0) return [];
  const due = await dueReminders(db, data, channels, now);
  if (due.length === 0) return [];
  const told: string[] = [];
  for (const ch of channels) {
    const after = (ch.reminderHours ?? Infinity) * HOUR;
    const mine = due.filter(
      (r) => ch.events.includes(r.kind) && now.getTime() - r.w.since >= after,
    );
    const claimed: Reminder[] = [];
    for (const r of mine) if (await data.notify.claimSend(ch.id, r.key)) claimed.push(r);
    if (claimed.length === 0) continue;
    told.push(ch.id);
    await send(data, out, ch, reminderMessage(claimed, now, out.origin));
  }
  return told;
}

/** Every account's due reminders; one that fails is logged and the rest still go. */
export async function runReminders(db: Db, out: Outbox, now = new Date()): Promise<void> {
  await forAccounts(await reminderAccounts(db), "reminders_failed", (id) =>
    sendReminders(db, out, id, now),
  );
}
