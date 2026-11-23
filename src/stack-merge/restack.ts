import type { RestackStart } from "../db/restack-jobs.js";
import type { Row, Scoped } from "../db/scoped.js";
import type { OpenPull } from "../platforms/stacks.js";

// The pull requests stacked on one that merged by squash or rebase still
// carry its original commits. Where the repository turned restacks on, each
// one moved onto the merged one's base is queued to be rebased there by the
// bot (`git rebase --onto <base> <merged head>`) and force-pushed with a
// lease on the head it had (src/node/restack-run.ts); off, it is only
// moved. The layers above a restacked one are queued once it was
// (./restack-work.ts), so a stack is restacked from the bottom up.

/** The merged pull request (or the restacked layer) the ones above it move off. */
export type RestackParent = {
  number: number;
  /** The merge's key: its commit, or the merged head where the platform names none. */
  merge: string;
  /** Its head before: the commits the ones above drop. */
  head: string;
  /** What they are rebased onto: the branch, at `commit` when one is named. */
  onto: { branch: string; commit: string | null };
};

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * A branch name git takes as given and no option: a restack names it to git
 * on the runner's command line. Stricter than git's own rules on purpose.
 */
export function safeBranch(name: string): boolean {
  return (
    name.length <= 250 &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.split("/").some((part) => part.startsWith("."))
  );
}

export const isCommit = (sha: string) => COMMIT.test(sha);

/** The commit a merge is known by: its merge or squash commit, else the head that merged. */
export const mergeKey = (mergeCommit: string | null | undefined, head: string) =>
  mergeCommit && isCommit(mergeCommit) ? mergeCommit : head;

/**
 * Queues a restack of each of `children`, already on the parent's new base,
 * unless the repository has restacks off, a stack merge holds the pull
 * request (its run merges it as it is) or this merge queued it already;
 * how many it queued.
 */
export async function queueRestacks(
  data: Scoped,
  repo: Row<"reviewRepos">,
  parent: RestackParent,
  children: readonly Pick<OpenPull, "number" | "head" | "headSha">[],
): Promise<number> {
  if (!repo.restack || !isCommit(parent.head) || !safeBranch(parent.onto.branch)) return 0;
  if (parent.onto.commit !== null && !isCommit(parent.onto.commit)) return 0;
  const key = { platform: repo.platform, host: repo.host, fullName: repo.fullName };
  let queued = 0;
  for (const child of children) {
    if (!safeBranch(child.head) || !isCommit(child.headSha)) continue;
    if (await data.stackMerges.heldBy(key, [child.number])) continue;
    const start: RestackStart = {
      reviewRepoId: repo.id,
      number: child.number,
      parentMerge: parent.merge,
      parent: parent.number,
      branch: child.head,
      head: child.headSha,
      ontoBranch: parent.onto.branch,
      ontoCommit: parent.onto.commit,
      upstream: parent.head,
    };
    if (await data.restacks.queue(start)) queued++;
  }
  return queued;
}

/** The enrolled repository a stack is in, if any: only one has a bot that may push. */
export const enrolledRepo = (
  data: Scoped,
  where: Pick<Row<"reviewRepos">, "platform" | "host" | "fullName">,
) => data.findOne("reviewRepos", where);
