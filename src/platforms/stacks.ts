import type { PullActionOutcome, StackedPull } from "../shared/index.js";

// A stack is derived from the platform's open pull requests, never stored:
// one whose base branch is another open one's head is stacked on it, so
// stacks made by hand or by other tools show too (ADR-0051).

/** An open pull request whose head branch is in the repository itself. */
export type OpenPull = Omit<StackedPull, "parent">;

export interface PullStacks {
  /** The repository's open pull requests, at most one page; null when unreached. */
  open(token: string, fullName: string): Promise<OpenPull[] | null>;
  /** Sets a pull request's base branch. */
  retarget(
    token: string,
    fullName: string,
    number: number,
    base: string,
  ): Promise<PullActionOutcome | null>;
}

export const MAX_STACK = 20;

/** The stack holding `number`, bottom to top with every pull after its parent; null when it is not open. */
export function stackOf(
  open: OpenPull[],
  number: number,
): { trunk: string; pulls: StackedPull[] } | null {
  const byNumber = new Map(open.map((p) => [p.number, p]));
  const byHead = new Map<string, OpenPull>();
  for (const p of [...open].sort((a, b) => a.number - b.number)) {
    if (!byHead.has(p.head)) byHead.set(p.head, p);
  }
  const parentOf = (p: OpenPull) => {
    const parent = byHead.get(p.base);
    return parent && parent.number !== p.number ? parent : undefined;
  };
  let root = byNumber.get(number);
  if (!root) return null;
  const seen = new Set<number>([root.number]);
  for (let up = parentOf(root); up && !seen.has(up.number); up = parentOf(up)) {
    seen.add(up.number);
    root = up;
  }
  const children = new Map<number, OpenPull[]>();
  for (const p of open) {
    const parent = parentOf(p);
    if (parent) children.set(parent.number, [...(children.get(parent.number) ?? []), p]);
  }
  const pulls: StackedPull[] = [];
  const placed = new Set<number>();
  const visit = (p: OpenPull, parent: number | null) => {
    if (placed.has(p.number) || pulls.length >= MAX_STACK) return;
    placed.add(p.number);
    pulls.push({ ...p, parent });
    for (const c of (children.get(p.number) ?? []).sort((a, b) => a.number - b.number)) {
      visit(c, p.number);
    }
  };
  visit(root, null);
  return { trunk: root.base, pulls };
}

/** The pull requests from the bottom of the stack up to and including `number`. */
export function chainTo(pulls: StackedPull[], number: number): StackedPull[] {
  const byNumber = new Map(pulls.map((p) => [p.number, p]));
  const chain: StackedPull[] = [];
  for (
    let p = byNumber.get(number);
    p;
    p = p.parent === null ? undefined : byNumber.get(p.parent)
  ) {
    if (chain.includes(p)) break;
    chain.unshift(p);
  }
  return chain;
}
