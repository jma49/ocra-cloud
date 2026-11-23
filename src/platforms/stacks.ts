import { type PullActionOutcome, pullStacks, type StackedPull } from "../shared/index.js";

// A stack is derived from the platform's open pull requests, never stored:
// one whose base branch is another open one's head is stacked on it, so
// stacks made by hand or by other tools show too (ADR-0052).

/** An open pull request whose head branch is in the repository itself. */
export type OpenPull = Omit<StackedPull, "parent">;

/**
 * Where one layer of a stack stands for its merge: `blocker` is null when
 * the platform would merge it now; `behind` when its base moved on and the
 * repository wants it up to date; `checks_pending` or `checks_failed` by the
 * head's checks; `waiting` for anything else (approvals, a draft, a state
 * the platform is still working out).
 */
export type LayerStanding = {
  state: "open" | "merged" | "closed";
  head: string;
  headBranch: string;
  base: string;
  blocker: "behind" | "conflicts" | "checks_pending" | "checks_failed" | "waiting" | null;
};

/** Pages of open pull requests read to find a stack: a stack's bottom may be older than the first. */
export const MAX_OPEN_PAGES = 10;

export interface PullStacks {
  /** The repository's open pull requests, at most MAX_OPEN_PAGES pages; null when unreached. */
  open(token: string, fullName: string): Promise<OpenPull[] | null>;
  /** The open pull requests whose base is `branch`, their heads in the repository itself. */
  children(token: string, fullName: string, branch: string): Promise<OpenPull[] | null>;
  standing(token: string, fullName: string, number: number): Promise<LayerStanding | null>;
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
