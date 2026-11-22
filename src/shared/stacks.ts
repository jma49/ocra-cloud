import type { CodePlatformKind } from "./domain.js";
import type { PullActionOutcome } from "./pull-page.js";
import type { PullChecks, PullReview } from "./pulls.js";

// A stack of pull requests, read from the platform: one whose base branch is
// another open one's head is stacked on it (ADR-0052).

export type StackedPull = {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  /** Branch names. */
  head: string;
  base: string;
  /** The head commit, which a merge of the stack names so a moved one is not merged blind. */
  headSha: string;
  /** The pull request it is stacked on; null for the bottom. */
  parent: number | null;
  checks: PullChecks;
  review: PullReview;
};

export type PullStackView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  /** The bottom's base branch, where the stack merges to. */
  trunk: string;
  /** Bottom to top, each after its parent; empty when the pull request is not open. */
  pulls: StackedPull[];
};

/** `unreached` when the platform did not answer; the steps after a stop are not tried. */
export type StackStepOutcome = PullActionOutcome | "unreached";

export type StackMergeStep = { number: number; outcome: StackStepOutcome };

export type StackMergeView = {
  steps: StackMergeStep[];
  /** Open pull requests that were stacked on a merged one, each retargeted to the trunk. */
  restacked: StackMergeStep[];
};

/**
 * A listed pull request's place in a stack of the pulls listed with it.
 * Only listed pull requests count: one stacked between two listed ones but
 * not itself listed (another author's, or past the listing's page) breaks
 * the stack there, so size counts listed pulls alone and may be less than
 * the stack on the platform holds.
 */
export type PullStackPlace = {
  /** `repo#number` of the stack's bottom listed pull; one for every pull of the stack. */
  id: string;
  /** From 1, the bottom; in a fork each branch follows its parent, lower numbers first. */
  position: number;
  /** How many listed pulls the stack holds, at least 2. */
  size: number;
};

/** An open pull request with its branch names, its head in the repository itself. */
export type StackBranches = { repo: string; number: number; head: string; base: string };

/** A pull's branches; `repo` keeps pulls of other repositories that share branch names apart. */
type Branches = { repo?: string; number: number; head: string; base: string };

export type StackNode<T> = { pull: T; parent: T | null };

/**
 * The stacks these pulls make, every pull in exactly one, each bottom first
 * with every pull after its parent. A pull is stacked on the one, in the same
 * repository, whose head branch is its base: of two with one head branch the
 * lower number is the parent, a fork is walked depth first with lower numbers
 * first, and a cycle of branches is cut above its lowest number, which
 * becomes the bottom.
 */
export function pullStacks<T extends Branches>(pulls: readonly T[]): StackNode<T>[][] {
  const key = (p: Branches) => JSON.stringify([p.repo ?? "", p.number]);
  const byHead = new Map<string, T>();
  for (const p of [...pulls].sort((a, b) => a.number - b.number)) {
    const at = JSON.stringify([p.repo ?? "", p.head]);
    if (!byHead.has(at)) byHead.set(at, p);
  }
  const parentOf = new Map<string, T>();
  const children = new Map<string, T[]>();
  for (const p of pulls) {
    const parent = byHead.get(JSON.stringify([p.repo ?? "", p.base]));
    if (!parent || key(parent) === key(p) || parentOf.has(key(p))) continue;
    parentOf.set(key(p), parent);
    children.set(key(parent), [...(children.get(key(parent)) ?? []), p]);
  }
  const bottomOf = (p: T) => {
    const path: T[] = [];
    let at: T | undefined = p;
    while (at && !path.includes(at)) {
      path.push(at);
      at = parentOf.get(key(at));
    }
    if (!at) return path[path.length - 1] ?? p;
    const cycle = path.slice(path.indexOf(at));
    return cycle.reduce((low, c) => (c.number < low.number ? c : low));
  };
  const placed = new Set<string>();
  const stacks: StackNode<T>[][] = [];
  for (const p of pulls) {
    if (placed.has(key(p))) continue;
    const bottom = bottomOf(p);
    const stack: StackNode<T>[] = [];
    const visit = (at: T, parent: T | null) => {
      if (placed.has(key(at))) return;
      placed.add(key(at));
      stack.push({ pull: at, parent });
      const above = (children.get(key(at)) ?? []).filter((c) => c !== bottom);
      for (const c of above.sort((a, b) => a.number - b.number)) visit(c, at);
    };
    visit(bottom, null);
    stacks.push(stack);
  }
  return stacks;
}

/**
 * Each pull's place in the stacks these pulls make (`pullStacks`), in input
 * order; none for a pull with nothing stacked on or under it.
 */
export function stackPlaces(pulls: readonly StackBranches[]): (PullStackPlace | undefined)[] {
  const key = (p: StackBranches) => `${p.repo}#${p.number}`;
  const places = new Map<string, PullStackPlace>();
  for (const stack of pullStacks(pulls)) {
    const bottom = stack[0]?.pull;
    if (!bottom || stack.length < 2) continue;
    for (const [i, { pull }] of stack.entries()) {
      places.set(key(pull), { id: key(bottom), position: i + 1, size: stack.length });
    }
  }
  return pulls.map((p) => places.get(key(p)));
}
