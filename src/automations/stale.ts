import { type CallBudget, uncapped } from "../calls.js";
import { accountsWithRules } from "../db/automations.js";
import type { Db } from "../db/client.js";
import { type Row, scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import type { Outbox } from "../notify/notify.js";
import type { BotTokens } from "../platforms/bot.js";
import type { CodePlatform } from "../platforms/platform.js";
import { DAY, HOUR } from "../time.js";
import { automateWith, MAX_RULES, type Runner } from "./run.js";

// The stale trigger, from the hourly run: an open pull request out of draft
// of an enrolled repository with no event its webhooks stored (pull_flows'
// seen_at: opened, pushed to, edited, labelled, reviewed) for a rule's
// staleHours. Its event is that quiet stretch, keyed by when it began, so
// each rule runs once on it (the run's unique (rule, event) index) and
// again only after a new event and a new stretch. A stretch that began
// longer than WINDOW before it went stale is never tried: the runs that
// claimed it are kept longer (30 days), so none runs twice.

const WINDOW = 7 * DAY;
/** Pull requests one account's sweep reads, those that went stale last first. */
const PER_ACCOUNT = 200;

export type StaleRunner = {
  db: Db;
  bots: BotTokens | undefined;
  platforms: readonly CodePlatform[];
  out: Outbox;
  env: Runner["env"];
};

type Rule = Row<"automationRules">;

/** What trying a rule's actions on one pull request may take: the bot's token, the files, each action. */
const callsFor = (rules: readonly Rule[]) =>
  4 + rules.reduce((n, r) => n + r.actions.length + (r.conditions.paths ? 1 : 0), 0);

const keyOf = (p: { reviewRepoId: string; number: number; seenAt: Date }) =>
  `stale:${p.reviewRepoId}#${p.number}@${p.seenAt.getTime()}`;

/** One account's stale pull requests tried on its stale rules; false when the budget ran out. */
async function sweepAccount(
  runner: StaleRunner,
  accountId: string,
  now: Date,
  calls: CallBudget,
): Promise<boolean> {
  const data = scoped(runner.db, accountId);
  const rules = (
    await data.find("automationRules", { trigger: "stale", enabled: true }, MAX_RULES)
  ).flatMap((r) => (r.conditions.staleHours ? [{ rule: r, hours: r.conditions.staleHours }] : []));
  if (rules.length === 0) return true;
  const fewest = Math.min(...rules.map((r) => r.hours));
  const most = Math.max(...rules.map((r) => r.hours));
  const t = now.getTime();
  const pulls = await data.pullFlows.quiet(
    new Date(t - most * HOUR - WINDOW),
    new Date(t - fewest * HOUR),
    PER_ACCOUNT,
  );
  const ran = await data.automations.ranOn(
    rules.map((r) => r.rule.id),
    pulls.map(keyOf),
  );
  const repos = new Map<string, Row<"reviewRepos"> | undefined>();
  const inAccount: Runner = { ...runner, data };
  for (const pull of pulls) {
    const key = keyOf(pull);
    const quiet = t - pull.seenAt.getTime();
    const due = rules
      .filter(
        (r) =>
          quiet >= r.hours * HOUR &&
          quiet <= r.hours * HOUR + WINDOW &&
          !ran.has(`${r.rule.id} ${key}`),
      )
      .map((r) => r.rule);
    if (due.length === 0) continue;
    if (!calls.has(callsFor(due))) return false;
    if (!repos.has(pull.reviewRepoId)) {
      repos.set(pull.reviewRepoId, await data.get("reviewRepos", pull.reviewRepoId));
    }
    const repo = repos.get(pull.reviewRepoId);
    if (!repo) continue;
    const { run } = await automateWith(
      inAccount,
      {
        trigger: "stale",
        eventKey: key,
        repo,
        pull: { host: repo.host, fullName: repo.fullName, number: pull.number },
        facts: {
          repoId: repo.id,
          title: pull.title,
          ...(pull.author ? { author: pull.author } : {}),
          quietHours: Math.floor(quiet / HOUR),
        },
        acts: true,
        consoleUrl: new URL("/settings", runner.out.origin).toString(),
      },
      due,
    );
    await run;
  }
  return true;
}

/** Every account's stale rules, within `calls`; one account that fails is logged and the rest go. */
export async function runStale(
  runner: StaleRunner,
  now = new Date(),
  calls: CallBudget = uncapped(),
): Promise<void> {
  for (const accountId of await accountsWithRules(runner.db, "stale")) {
    try {
      if (!(await sweepAccount(runner, accountId, now, calls))) return;
    } catch (e) {
      logError("stale_automation_failed", { error: errorName(e) });
    }
  }
}
