import type {
  AutomationAction,
  AutomationConditions,
  AutomationPullFacts,
  AutomationTrigger,
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
  return checks.every((check) => check());
}

/** The conditions only a pull request's own fields answer, which an upload does not carry. */
const PULL_CONDITIONS = ["authors", "baseBranches", "title", "labels"] as const;
/** The conditions only a review answers. */
const REVIEW_CONDITIONS = ["critical", "verdicts"] as const;

/** Why a rule cannot run on its trigger, as the field at fault; undefined when it can. */
export function triggerConflict(
  trigger: AutomationTrigger,
  conditions: AutomationConditions,
  actions: readonly AutomationAction[],
): (string | number)[] | undefined {
  const wrong = trigger === "queued" ? REVIEW_CONDITIONS : PULL_CONDITIONS;
  const condition = wrong.find((k) => conditions[k] !== undefined);
  if (condition) return ["conditions", condition];
  if (trigger === "reviewed") {
    const skip = actions.findIndex((a) => a.kind === "skip_review");
    if (skip >= 0) return ["actions", skip];
  }
  return undefined;
}
