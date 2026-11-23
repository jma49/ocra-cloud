import type { IndexRow, IndexValues } from "../db/pull-index.js";
import type { Scoped } from "../db/scoped.js";
import type { PullChecks, PullReview } from "../shared/index.js";

// What one source says of a pull request for the inbox's index, and how it
// merges into the row: a source older than the row (by the platform's own
// update time) changes nothing, one as new or newer replaces what it
// knows and keeps the rest. Checks and the review decision come only from
// a live listing; a new head clears them, as it leaves them unknown.

export type PullFacts = {
  number: number;
  /** The platform's update time of the pull request, which orders the sources. */
  changedAt: Date;
  pullId?: string | null;
  title?: string;
  url?: string;
  author?: string | null;
  authorId?: string | null;
  authorAvatar?: string | null;
  draft?: boolean;
  state?: IndexRow["state"];
  openedAt?: Date | null;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  labels?: string[];
  additions?: number | null;
  deletions?: number | null;
  head?: string | null;
  branches?: { head: string; base: string } | null;
  reviewerIds?: string[];
  assigneeIds?: string[];
  checks?: PullChecks;
  review?: PullReview;
};

const known = <T>(value: T | undefined, before: T): T => (value === undefined ? before : value);

/** The row's values after the facts; null when they change nothing, or cannot make a row. */
export function mergeFacts(read: IndexRow | undefined, f: PullFacts): IndexValues | null {
  if (read && f.changedAt < read.changedAt) return null;
  if (!read && (f.title === undefined || f.url === undefined || f.state === undefined)) return null;
  const headMoved = read !== undefined && f.head !== undefined && f.head !== read.head;
  const before: IndexValues = read ?? {
    reviewRepoId: "",
    number: f.number,
    pullId: null,
    title: f.title ?? "",
    url: f.url ?? "",
    author: null,
    authorId: null,
    authorAvatar: null,
    draft: false,
    state: f.state ?? "open",
    openedAt: f.openedAt ?? f.changedAt,
    changedAt: f.changedAt,
    mergedAt: null,
    closedAt: null,
    labels: [],
    additions: null,
    deletions: null,
    head: null,
    headBranch: null,
    baseBranch: null,
    reviewerIds: [],
    assigneeIds: [],
    checks: null,
    review: null,
  };
  const next: IndexValues = {
    reviewRepoId: before.reviewRepoId,
    number: before.number,
    pullId: f.pullId ?? before.pullId,
    title: known(f.title, before.title),
    url: known(f.url, before.url),
    author: f.author ?? before.author,
    authorId: f.authorId ?? before.authorId,
    authorAvatar: known(f.authorAvatar, before.authorAvatar),
    draft: known(f.draft, before.draft),
    state: known(f.state, before.state),
    openedAt: f.openedAt ?? before.openedAt,
    changedAt: f.changedAt,
    mergedAt: known(f.mergedAt, before.mergedAt),
    closedAt: known(f.closedAt, before.closedAt),
    labels: known(f.labels, before.labels),
    additions: f.additions ?? before.additions,
    deletions: f.deletions ?? before.deletions,
    head: known(f.head, before.head),
    headBranch: f.branches === undefined ? before.headBranch : (f.branches?.head ?? null),
    baseBranch: f.branches === undefined ? before.baseBranch : (f.branches?.base ?? null),
    reviewerIds: known(f.reviewerIds, before.reviewerIds),
    assigneeIds: known(f.assigneeIds, before.assigneeIds),
    checks: known(f.checks, headMoved ? null : before.checks),
    review: known(f.review, headMoved ? null : before.review),
  };
  if (read && JSON.stringify(next) === JSON.stringify(pick(read))) return null;
  return next;
}

function pick(row: IndexRow): IndexValues {
  const { id: _i, accountId: _a, revision: _r, createdAt: _c, ...values } = row;
  return values;
}

/** Tries a few times when another write came between the read and the write. */
const ATTEMPTS = 3;

/**
 * Merges what `factsOf` says, given the row as it stands, into the
 * repository's pull request; whether a row changed.
 */
export async function applyFacts(
  data: Scoped,
  reviewRepoId: string,
  number: number,
  factsOf: (read: IndexRow | undefined) => PullFacts | null,
): Promise<boolean> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const read = await data.pullIndex.of(reviewRepoId, number);
    const facts = factsOf(read);
    const values = facts && mergeFacts(read, facts);
    if (!values) return false;
    if (await data.pullIndex.write(read, { ...values, reviewRepoId, number })) return true;
  }
  return false;
}
