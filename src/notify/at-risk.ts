import type { CallBudget } from "../calls.js";
import type { Db } from "../db/client.js";
import { targetAccounts } from "../db/review-targets.js";
import { scoped } from "../db/scoped.js";
import { consolePullUrl } from "../merge-checks/run.js";
import { type AtRisk, readAtRisk } from "../review-targets.js";
import { DAY } from "../time.js";
import { type Message, plain } from "./channels.js";
import { forAccounts, plural } from "./digest.js";
import { type Outbox, send } from "./notify.js";
import { hourIn, isQuiet } from "./reminders.js";
import { span } from "./report.js";

// pull_at_risk, from the hourly run: the open pull requests of an account's
// enrolled repositories near or past a review target (src/review-targets.ts),
// read only from what the webhooks stored. Each channel claims each pull
// request and target by its key (with when its clock started) before one
// message lists all it claimed, so it goes once whichever host and process
// runs it; a changed target does not tell it again. Quiet hours hold it
// until they end; one that came near its target longer than WINDOW ago is
// never told, so its claim (kept 30 days) outlives it.

const WINDOW = 7 * DAY;
/** Pull requests a run claims per channel, those that came near their target last first. */
const CLAIMED = 100;
/** Pull requests a message names. */
const LISTED = 10;

const TARGET_LABEL = { first_review: "first review", merge: "merge" } as const;

const keyOf = (a: AtRisk) =>
  `at_risk:${a.target}:${a.pull.reviewRepoId}#${a.pull.number}:${a.since}`;

function atRiskMessage(list: readonly AtRisk[], now: number, origin: string): Message {
  const sorted = [...list].sort((a, b) => a.due - b.due);
  const shown = sorted.slice(0, LISTED).map((a) => [
    "• ",
    {
      label: `${a.pull.repo}#${a.pull.number}`,
      url: consolePullUrl(
        origin,
        { platform: a.pull.platform, fullName: a.pull.repo },
        a.pull.number,
      ),
    },
    ` ${plain(a.pull.title)} · ${TARGET_LABEL[a.target]} `,
    a.state === "past" ? `overdue by ${span(now - a.due)}` : `due in ${span(a.due - now)}`,
  ]);
  const more = list.length > LISTED ? [[`… and ${list.length - LISTED} more`]] : [];
  const pulls = sorted.map((a) => ({
    platform: a.pull.platform,
    repo: a.pull.repo,
    number: a.pull.number,
    consoleUrl: consolePullUrl(
      origin,
      { platform: a.pull.platform, fullName: a.pull.repo },
      a.pull.number,
    ),
    title: a.pull.title,
    target: a.target,
    state: a.state,
    due: new Date(a.due).toISOString(),
  }));
  return {
    event: "pull_at_risk",
    subject: `ocra: ${plural(list.length, "pull request")} at risk of a review target`,
    lines: [[`At risk of a review target (${list.length}):`], ...shown, ...more],
    hooks: [{ event: "pull_at_risk", data: { pulls } }],
  };
}

/** Sends one account's pull requests newly at risk, one message per channel; the channels told. */
async function sendAtRisk(
  db: Db,
  out: Outbox,
  accountId: string,
  now: Date,
  retentionDays: number,
): Promise<string[]> {
  const data = scoped(db, accountId);
  const all = await data.notify.subscribed("pull_at_risk");
  if (all.length === 0) return [];
  const hour = hourIn(now, await data.notify.timeZone());
  const channels = all.filter((ch) => !isQuiet(ch, hour));
  if (channels.length === 0) return [];
  const t = now.getTime();
  const { found } = await readAtRisk(data, null, t, retentionDays);
  const due = found
    .filter((a) => t - a.nearAt <= WINDOW)
    .sort((a, b) => b.nearAt - a.nearAt)
    .slice(0, CLAIMED);
  if (due.length === 0) return [];
  const told: string[] = [];
  for (const ch of channels) {
    const claimed: AtRisk[] = [];
    for (const a of due) if (await data.notify.claimSend(ch.id, keyOf(a))) claimed.push(a);
    if (claimed.length === 0) continue;
    told.push(ch.id);
    await send(data, out, ch, atRiskMessage(claimed, t, out.origin));
  }
  return told;
}

/** Every account's pull requests newly at risk; one that fails is logged and the rest still go. */
export async function runAtRisk(
  db: Db,
  out: Outbox,
  retentionDays: number,
  now = new Date(),
  calls?: CallBudget,
): Promise<void> {
  await forAccounts(
    await targetAccounts(db),
    "at_risk_failed",
    (id) => sendAtRisk(db, out, id, now, retentionDays),
    calls,
  );
}
