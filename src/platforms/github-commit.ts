import type { PullActionOutcome } from "../shared/index.js";
import { outcomeOf } from "./actions.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformCall, platformSend } from "./http.js";

// Several files changed in one commit on a pull request's branch, through
// GitHub's git database: a tree on the head's tree, a commit whose parent is
// the head, and the branch moved to it only as a fast forward, so a branch
// that gained commits since is not overwritten. Each file keeps its mode.

type Changed = { path: string; content: Uint8Array };
type Entry = { name: string; mode: number; type: string };
type Listed = {
  data?: {
    repository?: Record<string, { tree?: { oid: string; entries: Entry[] }; entries?: Entry[] }>;
  };
};

const BOM = [0xef, 0xbb, 0xbf];
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The text a tree entry's content takes; kept by hand, as not every runtime honours ignoreBOM. */
function textOf(bytes: Uint8Array): string {
  const bom = BOM.every((b, i) => bytes[i] === b);
  const text = decoder.decode(bom ? bytes.subarray(BOM.length) : bytes);
  return bom ? `﻿${text}` : text;
}

const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");
const nameOf = (path: string) => path.split("/").at(-1) ?? "";

/** The head's tree and the mode of each file, read in one query; null when unreachable. */
async function treeOf(
  host: GithubHost,
  token: string,
  fullName: string,
  head: string,
  paths: readonly string[],
): Promise<{ tree: string; modes: Map<string, string> } | null> {
  const [owner, name] = fullName.split("/");
  const dirs = [...new Set(paths.map(dirOf).filter((d) => d !== ""))];
  const entries = "entries { name mode type }";
  const query = `query($owner: String!, $name: String!, $head: GitObjectID!${dirs.map((_, i) => `, $e${i}: String!`).join("")}) {
  repository(owner: $owner, name: $name) {
    root: object(oid: $head) { ... on Commit { tree { oid ${entries} } } }
${dirs.map((_, i) => `    d${i}: object(expression: $e${i}) { ... on Tree { ${entries} } }`).join("\n")}
  }
}`;
  const variables: Record<string, string | undefined> = { owner, name, head };
  dirs.forEach((d, i) => {
    variables[`e${i}`] = `${head}:${d}`;
  });
  const answer = await platformCall<Listed>(host.graphql, {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const repository = answer?.data?.repository;
  const root = repository?.root?.tree;
  if (!repository || !root) return null;
  const listed = new Map<string, Entry[]>([["", root.entries]]);
  dirs.forEach((d, i) => {
    listed.set(d, repository[`d${i}`]?.entries ?? []);
  });
  const modes = new Map<string, string>();
  for (const path of paths) {
    const entry = listed.get(dirOf(path))?.find((e) => e.name === nameOf(path));
    if (entry?.type === "blob") modes.set(path, entry.mode.toString(8));
  }
  return { tree: root.oid, modes };
}

/** One commit of the files on `branch` of `fullName`, only as a fast forward of `head`. */
export async function commitFiles(
  host: GithubHost,
  token: string,
  fullName: string,
  target: { head: string; branch: string; message: string },
  files: readonly Changed[],
): Promise<PullActionOutcome | null> {
  const send = <T>(method: string, path: string, body: unknown) =>
    platformSend<T>(`${host.api}/repos/${githubRepoPath(fullName)}/git/${path}`, {
      method,
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const base = await treeOf(
    host,
    token,
    fullName,
    target.head,
    files.map((f) => f.path),
  );
  if (!base) return null;
  // A symbolic link or submodule is not a file to write text into.
  const modes = files.map((f) => base.modes.get(f.path));
  if (modes.some((m) => m !== "100644" && m !== "100755")) return "not_applicable";
  const tree = await send<{ sha: string }>("POST", "trees", {
    base_tree: base.tree,
    tree: files.map((f, i) => ({
      path: f.path,
      mode: modes[i],
      type: "blob",
      content: textOf(f.content),
    })),
  });
  if (outcomeOf(tree) !== "done") return outcomeOf(tree);
  if (!tree?.body?.sha) return null;
  const commit = await send<{ sha: string }>("POST", "commits", {
    message: target.message,
    tree: tree.body.sha,
    parents: [target.head],
  });
  if (outcomeOf(commit) !== "done") return outcomeOf(commit);
  if (!commit?.body?.sha) return null;
  const ref = target.branch.split("/").map(encodeURIComponent).join("/");
  // Not forced: GitHub answers 422 when the branch is no longer at the commit's parent.
  return outcomeOf(
    await send("PATCH", `refs/heads/${ref}`, { sha: commit.body.sha, force: false }),
    { 422: "head_moved" },
  );
}
