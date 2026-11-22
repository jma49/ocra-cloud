import type { Context } from "hono";
import { newId, type Row, type Scoped } from "../db/scoped.js";
import { ruleMessage } from "../notify/channels.js";
import { type Outbox, outboxOf, send } from "../notify/notify.js";
import type { BotCredential, BotTokens } from "../platforms/bot.js";
import type { CodePlatform } from "../platforms/platform.js";
import { platformsOf } from "../platforms/registry.js";
import { pullPageUrl } from "../review-pull.js";
import type {
  AutomationAction,
  AutomationActionOutcome,
  AutomationPullFacts,
  AutomationRunView,
  AutomationTrigger,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { conditionsHold } from "./rules.js";

// Running an account's rules on one event: the rules that match are read
// at once (a skip must be known before the review is queued), their
// actions run after the answer, each rule once per event (the run claims
// its event key first), and every action's outcome is kept in the run log.

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

type Runner = {
  data: Scoped;
  out: Outbox;
  bots: BotTokens | undefined;
  platforms: readonly CodePlatform[];
};

/** The account's enabled rules on the trigger whose conditions hold for the pull request. */
export async function matchingRules(
  data: Scoped,
  trigger: AutomationTrigger,
  facts: AutomationPullFacts,
): Promise<Row<"automationRules">[]> {
  const rules = await data.find("automationRules", { trigger, enabled: true }, MAX_RULES);
  return rules.filter((r) => conditionsHold(r.conditions, facts));
}

/**
 * Matches the account's rules to the event: whether one of them skips the
 * review, and the run of their actions, which the caller awaits or defers.
 */
export async function automate(
  c: Context<AppEnv>,
  data: Scoped,
  event: AutomationEvent,
): Promise<{ skipped: boolean; run: Promise<void> }> {
  const rules = await matchingRules(data, event.trigger, event.facts);
  const runner = {
    data,
    out: outboxOf(c),
    bots: c.var.bots,
    platforms: platformsOf(c.env, c.req.url),
  };
  return {
    skipped:
      event.trigger === "queued" &&
      rules.some((r) => r.actions.some((a) => a.kind === "skip_review")),
    run: rules.length > 0 ? runRules(runner, event, rules) : Promise.resolve(),
  };
}

async function runRules(runner: Runner, event: AutomationEvent, rules: Row<"automationRules">[]) {
  const bot = botOf(runner, event.repo);
  for (const rule of rules) {
    const actions = rule.actions.filter((a) => event.acts || a.kind === "skip_review");
    if (actions.length === 0) continue;
    const id = newId();
    const claimed = await runner.data.automations.claim({
      id,
      ruleId: rule.id,
      ruleName: rule.name,
      trigger: event.trigger,
      pull: `${event.pull.fullName}#${event.pull.number}`,
      eventKey: event.eventKey,
      actions: [],
    });
    if (!claimed) continue;
    const done: AutomationRunView["actions"] = [];
    for (const action of actions) {
      done.push({ kind: action.kind, outcome: await perform(runner, event, rule, action, bot) });
    }
    const ok = done.filter((d) => d.outcome === "done").length;
    const outcome = ok === done.length ? "done" : ok === 0 ? "failed" : "partial";
    await runner.data.update("automationRuns", id, { outcome, actions: done });
  }
}

type Bot = () => Promise<{ platform: CodePlatform; credential: BotCredential } | null>;

/** The bot's credential for the enrolled repository, minted once per event when an action needs it. */
function botOf(runner: Runner, repo: Row<"reviewRepos"> | null): Bot {
  let minted: ReturnType<Bot> | undefined;
  return () => {
    minted ??= (async () => {
      if (!repo || !runner.bots) return null;
      const platform = runner.platforms.find(
        (p) => p.kind === repo.platform && p.host === repo.host,
      );
      if (!platform) return null;
      const credential = await runner.bots.forRepo(repo.platform, repo.fullName);
      return credential ? { platform, credential } : null;
    })();
    return minted;
  };
}

async function perform(
  runner: Runner,
  event: AutomationEvent,
  rule: Row<"automationRules">,
  action: AutomationAction,
  bot: Bot,
): Promise<AutomationActionOutcome> {
  if (action.kind === "skip_review") return "done";
  if (action.kind === "notify") {
    const channel = await runner.data.get("notifyChannels", action.channelId);
    if (!channel) return "channel_gone";
    const platform = runner.platforms.find((p) => p.host === event.pull.host);
    const pull = { ...event.pull, repo: event.pull.fullName, head: "" };
    const message = ruleMessage({
      rule: rule.name,
      pull: {
        label: `${event.pull.fullName}#${event.pull.number}`,
        url: platform ? pullPageUrl(platform, pull) : null,
      },
      consoleUrl: event.consoleUrl,
    });
    return (await send(runner.data, runner.out, channel, message)) ? "done" : "unreached";
  }
  if (!event.repo) return "not_enrolled";
  if (!runner.bots) return "needs_self_hosted";
  const writer = await bot();
  if (!writer) return "refused";
  const { platform, credential } = writer;
  const { fullName } = event.repo;
  const n = event.pull.number;
  const sent =
    action.kind === "add_labels"
      ? await platform.actions.addLabels(credential.token, fullName, n, action.labels)
      : action.kind === "request_reviewers"
        ? await platform.actions.requestReviewers(credential.token, fullName, n, action.reviewers)
        : await platform.actions.comment(credential.token, fullName, n, action.body);
  if (sent === null) return "unreached";
  return sent === "done" ? "done" : "refused";
}
