import type { Scoped } from "../db/scoped.js";
import { NOTIFY_WHEN, type SpendWindowState, spendStates } from "../shared/index.js";
import { spendOf } from "../spend.js";
import { utcDay } from "../time.js";
import type { Message } from "./channels.js";
import { type Outbox, send } from "./notify.js";

// Telling the account its reviews' cost neared or reached a spend limit:
// once per window, period and level in each confirmed channel of a person,
// whatever reviews that channel hears about, since at the limit hosted
// reviews stop starting.

const usd = (n: number) => `$${n.toFixed(2)}`;

function spendMessage(s: SpendWindowState, origin: string): Message {
  const reached = s.level === "reached";
  const period = s.window === "daily" ? "today (UTC)" : "this month (UTC)";
  return {
    event: "spend_limit",
    subject: reached
      ? `ocra: the ${s.window} spend limit is reached`
      : `ocra: ${Math.floor(s.used * 100)}% of the ${s.window} spend limit is used`,
    lines: [
      [`ocra's reviews cost ${usd(s.spentUsd)} ${period}, of a ${usd(s.limitUsd)} limit.`],
      [
        reached
          ? "Hosted reviews wait until the limit resets or is raised."
          : "At the limit, hosted reviews wait until it resets or is raised.",
      ],
      [{ label: "Open the budget", url: new URL("/budget", origin).toString() }],
    ],
  };
}

/** Sends each window's warning or stop that no channel was told of yet. */
export async function tellSpend(data: Scoped, out: Outbox, now = new Date()): Promise<void> {
  const due = spendStates(await spendOf(data, now)).filter((s) => s.level !== "ok");
  if (due.length === 0) return;
  const channels = (await data.notify.listening(NOTIFY_WHEN)).filter((ch) => ch.kind !== "webhook");
  for (const s of due) {
    const period = utcDay(now).slice(0, s.window === "daily" ? 10 : 7);
    const key = `spend:${s.window}:${period}:${s.level}`;
    const message = spendMessage(s, out.origin);
    await Promise.all(
      channels.map(
        async (ch) => (await data.notify.claimSend(ch.id, key)) && send(data, out, ch, message),
      ),
    );
  }
}
