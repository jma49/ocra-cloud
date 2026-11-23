import type { Context } from "hono";
import type { RunResult } from "../db/automations.js";
import { newId, type Row, type Scoped } from "../db/scoped.js";
import { consolePullUrl } from "../merge-checks/run.js";
import { ruleMessage } from "../notify/channels.js";
import { type Outbox, outboxOf, send } from "../notify/notify.js";
import type { BotCredential, BotTokens } from "../platforms/bot.js";
import { accessToken } from "../platforms/links.js";
import type { CodePlatform } from "../platforms/platform.js";
import { platformsOf } from "../platforms/registry.js";
import { pullPageUrl } from "../review-pull.js";
import {
  type AutomationAction,
  type AutomationActionKind,
  type AutomationActionOutcome,
  type AutomationPullFacts,
  type AutomationRetry,
  type AutomationRunView,
  type AutomationSkipReason,
  type AutomationTrigger,
  MAX_AUTOMATION_PATHS,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { assignReviewers } from "./assign.js";
import { type ChangedPaths, pathsHold } from "./paths.js";
import { conditionsHold } from "./rules.js";

// Running an account's rules on one event: the rules that match are read
// at once (a skip must be known before the review is queued), their
// actions run after the answer, each rule once per event (the run claims
// its event key first), and every action's outcome is kept in the run log.
// A rule on paths reads the changed files once per event, as the bot or
// else the account's link, at most MAX_AUTOMATION_PATHS of them: what the
// platform lists is current, where an upload names no files. A rule they
// cannot decide is logged as skipped. A write the platform did not answer
// (a timeout, 5xx or 429) is tried again by retryAutomations (./retry.ts).

export const MAX_RULES = 50;

export type AutomationEvent = {
  trigger: AutomationTrigger;
  /** Unique per event of a rule: a retried delivery has the same key and runs nothing. */
  eventKey: string;
  /** The account's enrolled repository the pull request is on; the bot writes only there. */
  repo: Row<"reviewRepos"> | null;
  pull: { host: string; fullName: string; number: number };
  facts: AutomationPullFacts;
  /**
   * False for a queued pull request that only gained commits: then only a
   * skip applies, so a rule does not label or comment on every push.
   */
  acts: boolean;
  consoleUrl: string;
};

export type Runner = {
  data: Scoped;
  out: Outbox;
  bots: BotTokens | undefined;
  platforms: readonly CodePlatform[];
  env: Parameters<typeof accessToken>[1];
};

/** A transient failure is tried this many times in all, the first attempt included. */
export const MAX_ATTEMPTS = 3;
/** How long after a failed attempt (the first, the second) the next one is due. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000];

type Rule = Row<"automationRules">;
export type Matched = { rules: Rule[]; skipped: { rule: Rule; reason: AutomationSkipReason }[] };

/**
 * The account's enabled rules on the trigger whose conditions hold for the
 * pull request, and those its changed files, read only when a rule asks,
 * did not decide. With acts false only rules that skip the review are tried.
 */
export async function matchingRules(
  data: Scoped,
  trigger: AutomationTrigger,
  facts: AutomationPullFacts,
  changed: () => Promise<ChangedPaths | null>,
  acts = true,
  only?: readonly Rule[],
): Promise<Matched> {
  const rules = only ?? (await data.find("automationRules", { trigger, enabled: true }, MAX_RULES));
  const matched: Matched = { rules: [], skipped: [] };
  for (const rule of rules) {
    if (!acts && !rule.actions.some((a) => a.kind === "skip_review")) continue;
    if (!conditionsHold(rule.conditions, facts)) continue;
    const paths = rule.conditions.paths;
    const held = paths ? pathsHold(paths, await changed()) : true;
    if (held === true) matched.rules.push(rule);
    else if (held !== false) matched.skipped.push({ rule, reason: held });
  }
  return matched;
}

/**
 * Matches the account's rules to the event: whether one of them skips the
 * review, and the run of their actions, which the caller awaits or defers.
 */
export function automate(
  c: Context<AppEnv>,
  data: Scoped,
  event: AutomationEvent,
): Promise<{ skipped: boolean; run: Promise<void> }> {
  return automateWith(
    {
      data,
      out: outboxOf(c),
      bots: c.var.bots,
      platforms: platformsOf(c.env, c.req.url),
      env: c.env,
    },
    event,
  );
}

/** The same outside a request (the hourly run), on `only` of the trigger's rules where given. */
export async function automateWith(
  runner: Runner,
  event: AutomationEvent,
  only?: readonly Rule[],
): Promise<{ skipped: boolean; run: Promise<void> }> {
  const { data } = runner;
  const bot = botOf(runner, event.repo);
  let read: Promise<ChangedPaths | null> | undefined;
  const changed = () => {
    read ??= changedPaths(runner, event, bot);
    return read;
  };
  const matched = await matchingRules(data, event.trigger, event.facts, changed, event.acts, only);
  return {
    skipped:
      event.trigger === "queued" &&
      matched.rules.some((r) => r.actions.some((a) => a.kind === "skip_review")),
    run:
      matched.rules.length + matched.skipped.length > 0
        ? runRules(runner, event, matched, bot)
        : Promise.resolve(),
  };
}

async function changedPaths(
  runner: Runner,
  event: AutomationEvent,
  bot: Bot,
): Promise<ChangedPaths | null> {
  const platform = runner.platforms.find((p) =>
    event.repo
      ? p.kind === event.repo.platform && p.host === event.repo.host
      : p.host === event.pull.host,
  );
  if (!platform) return null;
  const token =
    (await bot())?.credential.token ?? (await accessToken(runner.data, runner.env, platform));
  if (!token) return null;
  const { fullName, number } = event.pull;
  const listed = await platform.changes.changes(token, fullName, number, MAX_AUTOMATION_PATHS);
  if (!listed) return null;
  const paths = new Set(listed.files.flatMap((f) => [f.path, f.oldPath]));
  return { paths: [...paths], truncated: listed.truncated };
}

async function runRules(runner: Runner, event: AutomationEvent, matched: Matched, bot: Bot) {
  const pull = `${event.pull.fullName}#${event.pull.number}`;
  for (const { rule, reason } of matched.skipped) {
    await runner.data.automations.claim({
      id: newId(),
      ruleId: rule.id,
      ruleName: rule.name,
      trigger: event.trigger,
      pull,
      eventKey: event.eventKey,
      outcome: "skipped",
      reason,
      actions: [],
    });
  }
  for (const rule of matched.rules) {
    const actions = rule.actions.filter((a) => event.acts || a.kind === "skip_review");
    if (actions.length === 0) continue;
    const id = newId();
    const claimed = await runner.data.automations.claim({
      id,
      ruleId: rule.id,
      ruleName: rule.name,
      trigger: event.trigger,
      pull,
      eventKey: event.eventKey,
      actions: [],
    });
    if (!claimed) continue;
    const done: AutomationRunView["actions"] = [];
    const tried: AutomationRetry["actions"] = [];
    for (const [index, action] of actions.entries()) {
      const { outcome, again } = await perform(runner, event, rule, action, bot);
      done.push({ kind: action.kind, outcome });
      tried.push({ index, action: again ?? action });
    }
    const retry = event.repo ? retryOf(event.repo.id, event.pull.number, tried, done) : null;
    await runner.data.automations.finish(id, 1, resultOf(done, retry, 1, new Date()));
  }
}

type BotWrite = Extract<AutomationAction, { kind: "add_labels" | "request_reviewers" | "comment" }>;
const RETRIED: readonly AutomationActionKind[] = ["add_labels", "request_reviewers", "comment"];

/** A write tried again; an assignment is too, as the request of the logins it chose. */
export const isRetried = (a: AutomationAction): a is BotWrite => RETRIED.includes(a.kind);

/** The bot's writes the platform did not answer, to try again; null when there are none. */
export function retryOf(
  reviewRepoId: string,
  number: number,
  tried: AutomationRetry["actions"],
  done: AutomationRunView["actions"],
): AutomationRetry | null {
  const actions = tried.filter(
    (t) => isRetried(t.action) && done[t.index]?.outcome === "unreached",
  );
  return actions.length > 0 ? { reviewRepoId, number, actions } : null;
}

/** Outcomes of an action that did what it had to: an assignment with nothing to do did. */
const OK: readonly AutomationActionOutcome[] = ["done", "enough_reviewers", "already_assigned"];

/** The attempt's result: its retry due after its backoff, unless it was the last. */
export function resultOf(
  actions: AutomationRunView["actions"],
  retry: AutomationRetry | null,
  attempts: number,
  now: Date,
): RunResult {
  const ok = actions.filter((d) => OK.includes(d.outcome)).length;
  const delay = RETRY_DELAYS_MS[attempts - 1];
  const again = retry && attempts < MAX_ATTEMPTS && delay !== undefined ? retry : null;
  return {
    outcome: ok === actions.length ? "done" : ok === 0 ? "failed" : "partial",
    actions,
    retry: again,
    retryAt: again && delay !== undefined ? new Date(now.getTime() + delay) : null,
  };
}

type Writer = { platform: CodePlatform; credential: BotCredential };
export type Bot = () => Promise<Writer | null>;

/** The bot's credential for the enrolled repository, minted once when an action needs it. */
export function botOf(
  runner: Pick<Runner, "bots" | "platforms">,
  repo: Row<"reviewRepos"> | null,
): Bot {
  let minted: ReturnType<Bot> | undefined;
  return () => {
    minted ??= (async () => {
      if (!repo || !runner.bots) return null;
      const platform = runner.platforms.find(
        (p) => p.kind === repo.platform && p.host === repo.host,
      );
      if (!platform) return null;
      const credential = await runner.bots.forRepo(repo);
      return credential ? { platform, credential } : null;
    })();
    return minted;
  };
}

/** A write on the pull request as the bot. */
export async function botWrite(
  bot: Bot,
  fullName: string,
  n: number,
  action: BotWrite,
): Promise<AutomationActionOutcome> {
  const writer = await bot();
  if (!writer) return "refused";
  const { platform, credential } = writer;
  const sent =
    action.kind === "add_labels"
      ? await platform.actions.addLabels(credential.token, fullName, n, action.labels)
      : action.kind === "request_reviewers"
        ? await platform.actions.requestReviewers(credential.token, fullName, n, action.reviewers)
        : await platform.actions.comment(credential.token, fullName, n, action.body);
  if (sent === null) return "unreached";
  return sent === "done" ? "done" : "refused";
}

type Performed = {
  outcome: AutomationActionOutcome;
  /** What a retry sends in its place: an assignment asks the logins it chose. */
  again?: AutomationAction;
};

async function perform(
  runner: Runner,
  event: AutomationEvent,
  rule: Rule,
  action: AutomationAction,
  bot: Bot,
): Promise<Performed> {
  if (action.kind === "skip_review") return { outcome: "done" };
  if (action.kind === "notify") {
    const channel = await runner.data.get("notifyChannels", action.channelId);
    if (!channel) return { outcome: "channel_gone" };
    const platform = runner.platforms.find((p) => p.host === event.pull.host);
    const pull = { repo: event.pull.fullName, number: event.pull.number };
    const message = ruleMessage({
      rule: rule.name,
      pull: {
        label: `${event.pull.fullName}#${event.pull.number}`,
        url: platform ? pullPageUrl(platform, pull) : null,
      },
      consoleUrl: event.consoleUrl,
      hookPull: platform
        ? {
            platform: platform.kind,
            ...pull,
            consoleUrl: consolePullUrl(
              runner.out.origin,
              { platform: platform.kind, fullName: pull.repo },
              pull.number,
            ),
          }
        : null,
    });
    const sent = await send(runner.data, runner.out, channel, message);
    return { outcome: sent ? "done" : "unreached" };
  }
  if (!event.repo) return { outcome: "not_enrolled" };
  if (!runner.bots) return { outcome: "needs_self_hosted" };
  if (action.kind === "assign_reviewers") {
    const { outcome, logins } = await assignReviewers(
      runner.data,
      bot,
      rule,
      event.repo,
      event.pull.number,
      action,
    );
    return logins.length > 0
      ? { outcome, again: { kind: "request_reviewers", reviewers: logins } }
      : { outcome };
  }
  return { outcome: await botWrite(bot, event.repo.fullName, event.pull.number, action) };
}
