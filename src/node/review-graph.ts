import { writeFile } from "node:fs/promises";
import type { Assignment } from "../auto-review/work.js";
import { blobIdOf, CODE_LINES, impactOf, pullView, withCode } from "../graph/impact.js";
import { errorName, logError } from "../log.js";
import { githubChanges } from "../platforms/github-changes.js";
import { githubHost } from "../platforms/github-host.js";
import { gitlabChanges } from "../platforms/gitlab-changes.js";
import type { ImpactView } from "../shared/index.js";
import { engineGraphParser } from "./engine-graph.js";
import { blobOf, type Clone, localGraph } from "./local-graph.js";

// A hosted review's code graph: the one its server keeps of the repository,
// brought up to the clone's head on this machine and given to the CLI
// (`--graph`), and, where the server cannot read a graph itself, what the
// reviewed pull request reaches in it, sent back to be kept. The review
// does not depend on either: a failure here is logged and the review runs.

/** How a machine reaches the graphs its server keeps. */
export type ReviewGraphs = {
  /** The newest graph kept of the repository, as text; undefined when none is. */
  newest(accountId: string, repoId: string, signal: AbortSignal): Promise<string | undefined>;
  /** Keeps what a reviewed pull request reaches; absent where the server answers from the graph. */
  keepImpact?(accountId: string, repoId: string, number: number, view: ImpactView): Promise<void>;
};

/** The graphs a review's machine reaches, and the repository's graph among them. */
type Kept = { graphs: ReviewGraphs; at: NonNullable<Assignment["graph"]> };
type Reviewed = Pick<Assignment, "id" | "accountId" | "repo" | "bot">;
type WrittenGraph = { file: string; text: string; commit: string; files: number };

/** Writes the graph of the clone's head to `file`; undefined when it could not. */
export async function writeReviewGraph(
  { graphs, at }: Kept,
  work: Reviewed,
  clone: Clone,
  file: string,
  signal: AbortSignal,
): Promise<WrittenGraph | undefined> {
  try {
    const previous = await graphs.newest(work.accountId, at.repoId, signal);
    const built = await localGraph(clone, "HEAD", previous, signal);
    await writeFile(file, built.graph);
    return { file, text: built.graph, commit: built.commit, files: built.files };
  } catch (e) {
    logError("review_graph_failed", { job: work.id, error: errorName(e) });
    return undefined;
  }
}

/**
 * The graph an impact is read from: the pull request's base, whose lines its
 * hunks name, made from the head's graph. The clone lacks a base on a branch
 * it did not fetch; the head's graph then answers, and says it is not the base's.
 */
async function atBase(
  clone: Clone,
  written: WrittenGraph,
  base: string,
  signal: AbortSignal,
): Promise<Omit<WrittenGraph, "file">> {
  if (written.commit === base) return written;
  try {
    const built = await localGraph(clone, base, written.text, signal);
    return { text: built.graph, commit: built.commit, files: built.files };
  } catch {
    return written;
  }
}

/** The graph of the pull request's head, which the review fetched; undefined when the clone lacks it. */
async function atHead(clone: Clone, written: WrittenGraph, head: string, signal: AbortSignal) {
  try {
    return engineGraphParser((await localGraph(clone, head, written.text, signal)).graph);
  } catch {
    return undefined;
  }
}

/** Works out what the pull request reaches in the graph and has the server keep it. */
export async function keepReviewImpact(
  { graphs, at }: Kept,
  work: Reviewed,
  clone: Clone,
  written: WrittenGraph,
): Promise<void> {
  if (!graphs.keepImpact) return;
  try {
    const { repo, bot } = work;
    const reader =
      repo.platform === "github" ? githubChanges(githubHost(repo.url)) : gitlabChanges(repo.url);
    const changes = await reader.changes(bot.token, repo.fullName, at.pull);
    if (!changes) return;
    const signal = AbortSignal.timeout(60_000);
    const read = await atBase(clone, written, changes.base, signal);
    const graph = engineGraphParser(read.text);
    if (!graph) return;
    const head = await atHead(clone, written, changes.head, signal);
    const impact = impactOf(graph, changes.files, head);
    const symbols = await withCode(impact.symbols, CODE_LINES, async (path) => {
      const blobId = blobIdOf(graph, path);
      const bytes = blobId && (await blobOf(clone, blobId, signal));
      return bytes ? new TextDecoder().decode(bytes).split("\n") : undefined;
    });
    await graphs.keepImpact(work.accountId, at.repoId, at.pull, {
      pull: pullView(changes),
      graph: {
        commit: read.commit,
        current: read.commit === changes.base,
        truncated: false,
        files: read.files,
      },
      build: null,
      symbols,
      more: impact.more,
    });
  } catch (e) {
    logError("review_impact_failed", { job: work.id, error: errorName(e) });
  }
}
