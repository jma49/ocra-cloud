import type { Db } from "../db/client.js";
import { HELD_FOR, heldAccounts } from "../db/notify.js";
import { type Row, scoped } from "../db/scoped.js";
import { consolePullUrl } from "../merge-checks/run.js";
import type { Message } from "./channels.js";
import { forAccounts, plural } from "./digest.js";
import { type Outbox, send } from "./notify.js";
import { hourIn, isQuiet } from "./reminders.js";

// The comment notices that came in a channel's quiet hours, held and sent
// from the hourly run once they end: one message per channel, newest first.
// A run claims the notices before their message goes and deletes them after,
// so two runs, or two processes, send each once; a message that fails is
// not sent again. A notice held longer than HELD_FOR is dropped.

/** Notices one message takes; the rest go in the next run's. */
const CLAIMED = 100;
/** Notices a message names. */
const LISTED = 10;
/** Accounts one run flushes. */
const ACCOUNTS = 500;

type Held = Row<"notifyHeld">;

function heldMessage(held: readonly Held[], origin: string): Message {
  const shown = held.slice(0, LISTED).map((n) => [
    "• ",
    {
      label: `${n.repo}#${n.number}`,
      url: consolePullUrl(origin, { platform: n.platform, fullName: n.repo }, n.number),
    },
    ` ${n.line}`,
  ]);
  const more = held.length > LISTED ? [[`… and ${held.length - LISTED} more`]] : [];
  return {
    subject: `ocra: ${plural(held.length, "notice")} from your quiet hours`,
    lines: [
      [`While your quiet hours lasted (${plural(held.length, "notice")}):`],
      ...shown,
      ...more,
    ],
  };
}

/** Sends one account's held notices whose channels' quiet hours are over; the channels told. */
async function flushAccount(db: Db, out: Outbox, accountId: string, now: Date) {
  const data = scoped(db, accountId);
  const channels = await data.notify.holding();
  if (channels.length === 0) return [];
  const hour = hourIn(now, await data.notify.timeZone());
  const since = new Date(now.getTime() - HELD_FOR);
  const told: string[] = [];
  for (const ch of channels) {
    if (isQuiet(ch, hour)) continue;
    const held = await data.notify.claimHeld(ch.id, since, CLAIMED, now);
    if (held.length === 0) continue;
    told.push(ch.id);
    await send(data, out, ch, heldMessage(held, out.origin));
    await data.notify.dropHeld(held.map((n) => n.id));
  }
  return told;
}

/** Every account's held notices due now; one that fails is logged and the rest still go. */
export async function runHeld(db: Db, out: Outbox, now = new Date()): Promise<void> {
  const accounts = await heldAccounts(db, new Date(now.getTime() - HELD_FOR), ACCOUNTS);
  await forAccounts(accounts, "held_notices_failed", (id) => flushAccount(db, out, id, now));
}
