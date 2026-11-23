import {
  type AutomationAction,
  type AutomationConditionKey,
  type AutomationConditions,
  type AutomationPullFacts,
  type AutomationTrigger,
  REQUIRED_CONDITIONS,
  TRIGGER_CONDITIONS,
} from "../shared/index.js";

// Whether a rule's conditions hold for a pull request: each one set must,
// and a fact the event did not carry holds for none. Logins and labels are
// compared case-folded, as the platforms treat them.

const fold = (s: string) => s.toLowerCase();
const anyOf = (wanted: readonly string[], have: readonly string[]) => {
  const set = new Set(have.map(fold));
  return wanted.some((w) => set.has(fold(w)));
};

/**
 * A wildcard match, `*` any text and `?` one character, case-folded: one
 * pass that backs up only to the last `*`, so its time is bounded by the
 * lengths' product whatever the pattern, unlike a regular expression.
 */
export function globMatch(pattern: string, text: string): boolean {
  const p = [...fold(pattern)];
  const t = [...fold(text)];
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < t.length) {
    if (i < p.length && (p[i] === "?" || (p[i] !== "*" && p[i] === t[j]))) {
      i++;
      j++;
    } else if (i < p.length && p[i] === "*") {
      star = i++;
      mark = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else {
      return false;
    }
  }
  while (p[i] === "*") i++;
  return i === p.length;
}

export function conditionsHold(c: AutomationConditions, f: AutomationPullFacts): boolean {
  const checks: (() => boolean)[] = [];
  if (c.repoIds)
    checks.push(() => f.repoId !== undefined && c.repoIds?.includes(f.repoId) === true);
  if (c.authors) checks.push(() => f.author !== undefined && anyOf(c.authors ?? [], [f.author]));
  if (c.baseBranches) {
    checks.push(
      () => f.baseBranch !== undefined && c.baseBranches?.includes(f.baseBranch) === true,
    );
  }
  if (c.title !== undefined) {
    checks.push(() => f.title !== undefined && globMatch(c.title ?? "", f.title));
  }
  if (c.labels) checks.push(() => f.labels !== undefined && anyOf(c.labels ?? [], f.labels));
  if (c.critical !== undefined) checks.push(() => f.critical === c.critical);
  if (c.verdicts) {
    checks.push(() => f.verdict !== undefined && c.verdicts?.includes(f.verdict) === true);
  }
  if (c.staleHours !== undefined) {
    const hours = c.staleHours;
    checks.push(() => f.quietHours !== undefined && f.quietHours >= hours);
  }
  return checks.every((check) => check());
}

/** Actions only a pull request queued for review takes. */
const QUEUED_ACTIONS: readonly AutomationAction["kind"][] = ["skip_review", "assign_reviewers"];

type Conflict = { path: (string | number)[]; message: string };

/** Why a rule cannot run on its trigger, as the field at fault; undefined when it can. */
export function triggerConflict(
  trigger: AutomationTrigger,
  conditions: AutomationConditions,
  actions: readonly AutomationAction[],
): Conflict | undefined {
  const not = (path: (string | number)[]) => ({ path, message: `not for a rule on ${trigger}` });
  const allowed = TRIGGER_CONDITIONS[trigger];
  const set = Object.keys(conditions).filter(
    (k) => conditions[k as AutomationConditionKey] !== undefined,
  ) as AutomationConditionKey[];
  const wrong = set.find((k) => !allowed.includes(k));
  if (wrong) return not(["conditions", wrong]);
  const required = REQUIRED_CONDITIONS[trigger];
  if (required && conditions[required] === undefined) {
    return { path: ["conditions", required], message: `required for a rule on ${trigger}` };
  }
  if (trigger !== "queued") {
    const queuedOnly = actions.findIndex((a) => QUEUED_ACTIONS.includes(a.kind));
    if (queuedOnly >= 0) return not(["actions", queuedOnly]);
  }
  return undefined;
}
