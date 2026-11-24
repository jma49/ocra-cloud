import { type PullActionOutcome, pullStacks, type StackedPull } from "../shared/index.js";

// A stack is derived from the platform's open pull requests, never stored:
// one whose base branch is another open one's head is stacked on it, so
// stacks made by hand or by other tools show too (ADR-0052).

/** An open pull request whose head branch is in the repository itself. */
export type OpenPull = Omit<StackedPull, "parent" | "behind">;

/** Two branches of one repository: `head` built on `base`. */
export type BranchPair = { head: string; base: string };

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
  /** A merged one's merge commit (or squash), where the platform names it. */
  mergeCommit?: string | null;
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
  /**
   * The latest pull request merged from `head` into `base` at or after `since`, its head in the
   * repository, from one call listing `head`'s newest MERGED_FROM_PAGE; null when none merged so,
   * when one from `head` is still open (the branch lives on), or when unreached.
   */
  mergedFrom(
    token: string,
    fullName: string,
    head: string,
    base: string,
    since: Date,
  ): Promise<number | null>;
  /** For each pair, how many of `base`'s commits `head` lacks; null where it could not be read. */
  behind(token: string, fullName: string, pairs: readonly BranchPair[]): Promise<(number | null)[]>;
  /** Sets a pull request's base branch. */
  retarget(
    token: string,
    fullName: string,
    number: number,
    base: string,
  ): Promise<PullActionOutcome | null>;
}

export const MAX_STACK = 20;

/** Pull requests from one head branch `mergedFrom` reads, newest first: a branch is seldom reused. */
export const MERGED_FROM_PAGE = 20;

/** A listed pull request from a head branch, as `mergedFrom` weighs it. */
export type FromHead = { number: number; open: boolean; base: string; mergedAt: string | null };

/** The latest of `listed` merged into `base` at or after `since`, unless one is still open. */
export function latestMerged(listed: readonly FromHead[], base: string, since: Date) {
  if (listed.some((p) => p.open)) return null;
  let latest: { number: number; at: number } | null = null;
  for (const p of listed) {
    const at = p.mergedAt ? Date.parse(p.mergedAt) : Number.NaN;
    if (p.base !== base || !(at >= since.getTime())) continue;
    if (!latest || at > latest.at) latest = { number: p.number, at };
  }
  return latest?.number ?? null;
}

export type Stack = { trunk: string; pulls: Omit<StackedPull, "behind">[] };

/** The stack holding `number`, bottom to top with every pull after its parent (`pullStacks`); null when it is not open. */
export function stackOf(open: OpenPull[], number: number): Stack | null {
  const stack = pullStacks(open).find((s) => s.some((n) => n.pull.number === number));
  const bottom = stack?.[0]?.pull;
  if (!stack || !bottom) return null;
  const pulls = stack
    .slice(0, MAX_STACK)
    .map(({ pull, parent }) => ({ ...pull, parent: parent?.number ?? null }));
  return { trunk: bottom.base, pulls };
}

/** The stack's layers, each with how far its branch is behind the one it is stacked on. */
export async function withBehind(
  stacks: PullStacks,
  token: string,
  fullName: string,
  pulls: Stack["pulls"],
): Promise<StackedPull[]> {
  const stacked = pulls.filter((p) => p.parent !== null);
  const counts = await stacks.behind(
    token,
    fullName,
    stacked.map((p) => ({ head: p.head, base: p.base })),
  );
  const byNumber = new Map(stacked.map((p, i) => [p.number, counts[i] ?? null]));
  return pulls.map((p) => ({ ...p, behind: byNumber.get(p.number) ?? null }));
}
