import type {
  AssignStrategy,
  AutomationAction,
  AutomationActionKind,
  AutomationActionOutcome,
  AutomationConditions,
  AutomationRuleView,
  AutomationRunView,
  AutomationSkipReason,
  AutomationTrigger,
  Verdict,
} from "../../../src/shared/index.js";
import { count } from "../format.js";

// What the automations page says about a rule, its actions and their runs.

export const ACTION_LABEL: Record<AutomationActionKind, string> = {
  add_labels: "Add labels",
  request_reviewers: "Request reviewers",
  comment: "Comment",
  notify: "Notify a channel",
  skip_review: "Skip the review",
  assign_reviewers: "Assign reviewers",
};

const STRATEGY_LABEL: Record<AssignStrategy, string> = {
  suggested: "suggested",
  round_robin: "in turn",
  least_loaded: "least loaded",
};

/** The vocabulary's verdicts; listed here because the web takes only the contract's types. */
export const VERDICT_LABEL: Record<Verdict, string> = {
  approved: "Approved",
  approved_with_comments: "Approved with comments",
  minor_issues: "Minor issues",
  significant_concerns: "Significant concerns",
};
/** A rule's moment, as the choice of one names it. */
export const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  queued: "Queued for review",
  reviewed: "Reviewed",
  ready_for_review: "Marked ready for review",
  approved: "Approved",
  checks_failed: "CI failed",
  labeled: "Label added",
  merged: "Merged",
  stale: "Gone quiet",
};

const WHEN: Record<AutomationTrigger, string> = {
  queued: "When queued",
  reviewed: "When reviewed",
  ready_for_review: "When ready for review",
  approved: "When approved",
  checks_failed: "When CI fails",
  labeled: "When labelled",
  merged: "When merged",
  stale: "When quiet",
};

/** Hours as a rule says them: whole days where they are. */
const span = (hours: number) =>
  hours % 24 === 0 ? count(hours / 24, "day") : count(hours, "hour");

export const VERDICT_LIST = Object.keys(VERDICT_LABEL) as Verdict[];

export const OUTCOME_LABEL: Record<AutomationActionOutcome, string> = {
  done: "Done",
  refused: "Refused",
  unreached: "Not reached",
  needs_self_hosted: "Needs a self-hosted server",
  not_enrolled: "Repository not enrolled",
  channel_gone: "Channel removed",
  enough_reviewers: "Enough reviewers already",
  already_assigned: "Assigned before",
  no_candidates: "No one to assign",
};

export const RUN_LABEL: Record<AutomationRunView["outcome"], string> = {
  running: "Running",
  done: "Done",
  partial: "Partly done",
  failed: "Failed",
  skipped: "Skipped",
};

export const SKIP_LABEL: Record<AutomationSkipReason, string> = {
  paths_unavailable: "Changed files not readable",
  too_many_files: "Too many changed files to decide",
};

/** The actions a rule on this trigger may take; the server refuses the others. */
export function actionsFor(trigger: AutomationTrigger): AutomationActionKind[] {
  const all = Object.keys(ACTION_LABEL) as AutomationActionKind[];
  return trigger === "queued"
    ? all
    : all.filter((k) => k !== "skip_review" && k !== "assign_reviewers");
}

type Names = { repo: (id: string) => string; channel: (id: string) => string };

const any = (items: string[]) =>
  items.length > 2 ? `${items.length} of them` : items.join(" or ");

/** The rule's conditions in words; an empty list means every pull request. */
function conditionText(c: AutomationConditions, names: Names): string[] {
  const out: string[] = [];
  if (c.repoIds?.length) out.push(`in ${any(c.repoIds.map(names.repo))}`);
  if (c.authors?.length) out.push(`by ${any(c.authors)}`);
  if (c.baseBranches?.length) out.push(`into ${any(c.baseBranches)}`);
  if (c.title) out.push(`titled “${c.title}”`);
  if (c.labels?.length) out.push(`labelled ${any(c.labels)}`);
  if (c.critical !== undefined)
    out.push(c.critical ? "with a critical finding" : "with nothing critical");
  if (c.verdicts?.length) out.push(`judged ${any(c.verdicts.map((v) => VERDICT_LABEL[v]))}`);
  if (c.paths) {
    const files = c.paths.include?.length ? `files in ${any(c.paths.include)}` : "files";
    const but = c.paths.exclude?.length ? ` outside ${any(c.paths.exclude)}` : "";
    out.push(`changing ${c.paths.every ? "only " : ""}${files}${but}`);
  }
  return out;
}

function actionText(a: AutomationAction, names: Names): string {
  switch (a.kind) {
    case "add_labels":
      return `label ${a.labels.join(", ")}`;
    case "request_reviewers":
      return `ask ${a.reviewers.join(", ")}`;
    case "comment":
      return "comment";
    case "notify":
      return `notify ${names.channel(a.channelId)}`;
    case "skip_review":
      return "skip the review";
    case "assign_reviewers": {
      const who =
        a.strategy === "suggested"
          ? `assign ${a.count} suggested`
          : `assign ${a.count} of ${a.logins?.join(", ") ?? ""}, ${STRATEGY_LABEL[a.strategy]}`;
      return a.codeOwnersFirst ? `${who}, code owners first` : who;
    }
  }
}

export function ruleSummary(r: AutomationRuleView, names: Names): string {
  // What the trigger requires is part of the moment, not one more condition.
  const { labels, staleHours, ...rest } = r.conditions;
  const when =
    r.trigger === "labeled" && labels?.length
      ? `${WHEN.labeled} ${any(labels)}`
      : r.trigger === "stale" && staleHours
        ? `${WHEN.stale} for ${span(staleHours)}`
        : WHEN[r.trigger];
  const conds = conditionText(r.trigger === "labeled" ? rest : { ...rest, labels }, names);
  return `${when}${conds.length ? `, ${conds.join(", ")}` : ""}: ${r.actions
    .map((a) => actionText(a, names))
    .join(", ")}`;
}
