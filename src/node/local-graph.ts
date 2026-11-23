import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GraphBuildOutput } from "../graph/builder.js";
import { MAX_BLOB_BYTES } from "../graph/runner.js";
import type { TreeEntry } from "../platforms/contents.js";
import { baseEnv } from "./checkout.js";
import { engineGraphBuilder } from "./engine-graph.js";

// A commit's code graph from a clone on this machine: its tree and only the
// blobs the previous graph lacks, read as git objects. Nothing from the
// repository runs: no checkout, hook, filter or diff driver.

const run = promisify(execFile);
/** A tree's listing: about 100 bytes a file. */
const MAX_LISTING_BYTES = 512 * 1024 * 1024;

export type LocalGraph = GraphBuildOutput & { commit: string };

/** A job's clone, and the home directory git reads its settings from: the job's own, never the clone. */
export type Clone = { checkout: string; home: string };

/** Reads git objects of the clone: stdout, as bytes. */
export type GitRead = (
  clone: Clone,
  args: readonly string[],
  maxBytes: number,
  signal: AbortSignal,
) => Promise<Buffer>;

const gitRead: GitRead = async (clone, args, maxBytes, signal) => {
  const { stdout } = await run("git", [...args], {
    cwd: clone.checkout,
    // The Worker's typing of process.env names its bindings; a child gets none of them.
    env: baseEnv(clone.home) as unknown as NodeJS.ProcessEnv,
    encoding: "buffer",
    maxBuffer: maxBytes,
    signal,
  });
  return stdout;
};

/** The regular files of a `git ls-tree -r -z -l` listing; links and submodules are left out. */
function treeOf(listing: string): TreeEntry[] {
  return listing.split("\0").flatMap((line) => {
    const entry = /^100(?:644|755) blob ([0-9a-f]+) +(\d+)\t(.+)$/s.exec(line);
    return entry?.[1] && entry[3]
      ? [{ blobId: entry[1], size: Number(entry[2]), path: entry[3] }]
      : [];
  });
}

/** The graph of `rev` in the clone, starting from `previous` (a graph's text) when there is one. */
export async function localGraph(
  clone: Clone,
  rev: string,
  previous: string | undefined,
  signal: AbortSignal,
  git: GitRead = gitRead,
): Promise<LocalGraph> {
  const resolved = await git(
    clone,
    ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`],
    200,
    signal,
  );
  const commit = resolved.toString().trim();
  const listing = await git(
    clone,
    ["ls-tree", "-r", "-z", "-l", commit],
    MAX_LISTING_BYTES,
    signal,
  );
  const built = await engineGraphBuilder({
    previous,
    tree: treeOf(listing.toString()),
    readBlob: (blobId) => blobOf(clone, blobId, signal, git),
    revision: commit,
    maxBlobBytes: MAX_BLOB_BYTES,
    signal,
  });
  return { ...built, commit };
}

/** A blob's bytes; undefined when it cannot be read or is over the size a graph reads. */
export const blobOf = (
  clone: Clone,
  blobId: string,
  signal: AbortSignal,
  git: GitRead = gitRead,
): Promise<Uint8Array | undefined> =>
  git(clone, ["cat-file", "blob", blobId], MAX_BLOB_BYTES, signal).then(
    (bytes) => new Uint8Array(bytes),
    () => undefined,
  );
