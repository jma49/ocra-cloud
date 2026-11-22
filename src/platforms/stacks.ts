import { type PullActionOutcome, pullStacks, type StackedPull } from "../shared/index.js";

// A stack is derived from the platform's open pull requests, never stored:
// one whose base branch is another open one's head is stacked on it, so
// stacks made by hand or by other tools show too (ADR-0052).

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

/** The stack holding `number`, bottom to top with every pull after its parent (`pullStacks`); null when it is not open. */
export function stackOf(
  open: OpenPull[],
  number: number,
): { trunk: string; pulls: StackedPull[] } | null {
  const stack = pullStacks(open).find((s) => s.some((n) => n.pull.number === number));
  const bottom = stack?.[0]?.pull;
  if (!stack || !bottom) return null;
  const pulls = stack
    .slice(0, MAX_STACK)
    .map(({ pull, parent }) => ({ ...pull, parent: parent?.number ?? null }));
  return { trunk: bottom.base, pulls };
}
