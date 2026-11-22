import {
  conflict,
  type FileChangeResult,
  type FileRead,
  guardOf,
  type RepoFiles,
  refused,
} from "./files.js";
import { toBase64 } from "./fix.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubGraphql, GithubHost } from "./github-host.js";
import { platformSend } from "./http.js";

type Blob = {
  oid?: string;
  byteSize: number;
  isBinary: boolean;
  isTruncated: boolean;
  text: string | null;
};
type History = { nodes: { oid: string; committedDate: string }[] };
type ReadAnswer = {
  data?: {
    repository?: (Record<string, Blob | null> & { at?: Record<string, History> | null }) | null;
  };
};

// Paths go in as variables, never into the query's text.
function readQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `, $e${i}: String!, $p${i}: String!`).join(
    "",
  );
  const blobs = Array.from(
    { length: count },
    (_, i) =>
      `b${i}: object(expression: $e${i}) { ... on Blob { oid byteSize isBinary isTruncated text } }`,
  ).join("\n");
  const histories = Array.from(
    { length: count },
    (_, i) => `h${i}: history(path: $p${i}, first: 1) { nodes { oid committedDate } }`,
  ).join("\n");
  return `query($owner: String!, $name: String!, $oid: GitObjectID!${vars}) {
  repository(owner: $owner, name: $name) {
    ${blobs}
    at: object(oid: $oid) { ... on Commit { ${histories} } }
  }
}`;
}

export function githubFiles(host: GithubHost, post: GithubGraphql): RepoFiles {
  const repoUrl = (fullName: string) => `${host.api}/repos/${githubRepoPath(fullName)}`;
  const send = (token: string, method: string, url: string, body?: unknown) =>
    platformSend<Record<string, unknown>>(url, {
      method,
      headers: {
        ...githubHeaders(token),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    async read(token, repo, commit, paths, maxBytes) {
      if (paths.length === 0) return [];
      const [owner, name] = repo.fullName.split("/");
      const variables: Record<string, string> = {
        owner: owner ?? "",
        name: name ?? "",
        oid: commit,
      };
      paths.forEach((p, i) => {
        variables[`e${i}`] = `${commit}:${p}`;
        variables[`p${i}`] = p;
      });
      const answer = await post(token)<ReadAnswer>({
        query: readQuery(paths.length),
        variables,
      });
      const repository = answer?.data?.repository;
      if (!repository) return null;
      return paths.map((path, i): FileRead => {
        const blob = repository[`b${i}`] as Blob | null | undefined;
        const last = repository.at?.[`h${i}`]?.nodes[0];
        const readable =
          blob &&
          !blob.isBinary &&
          !blob.isTruncated &&
          blob.text !== null &&
          blob.byteSize <= maxBytes;
        return {
          path,
          // null: no object at the path; an object but not a blob (a directory) has no oid here.
          blobId: blob === null || blob === undefined ? null : (blob.oid ?? ""),
          bytes: readable && blob.text !== null ? new TextEncoder().encode(blob.text) : undefined,
          lastCommit: last ? { sha: last.oid, at: last.committedDate } : null,
        };
      });
    },
    async commit(token, head, change): Promise<FileChangeResult | null> {
      const url = repoUrl(head.fullName);
      const file = `${url}/contents/${githubRepoPath(change.path)}`;
      const read = await send(token, "GET", `${file}?ref=${head.commit}`);
      if (!read) return null;
      if (read.status !== 200 && read.status !== 404) return read.status < 500 ? refused : null;
      const found =
        read.status === 404 || typeof read.body?.sha !== "string"
          ? ("missing" as const)
          : { blobId: read.body.sha };
      if (guardOf(found, change.expected) === "conflict") return conflict;
      const branch = change.pull?.branch ?? head.branch;
      if (change.pull) {
        const made = await send(token, "POST", `${url}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: head.commit,
        });
        if (!made) return null;
        if (made.status !== 201) return made.status < 500 ? refused : null;
      }
      const dropBranch = async () => {
        if (change.pull)
          await send(token, "DELETE", `${url}/git/refs/heads/${githubRepoPath(branch)}`);
      };
      // sha: the blob as it was read; GitHub refuses the write when the file changed since.
      const written = change.content
        ? await send(token, "PUT", file, {
            message: change.message,
            content: toBase64(change.content),
            branch,
            ...(change.expected ? { sha: change.expected } : {}),
          })
        : await send(token, "DELETE", file, {
            message: change.message,
            sha: change.expected,
            branch,
          });
      if (!written || written.status < 200 || written.status >= 300) {
        await dropBranch();
        if (!written) return null;
        if (written.status === 409 || written.status === 422) return conflict;
        return written.status < 500 ? refused : null;
      }
      if (!change.pull) return { outcome: "done", pull: null };
      const opened = await send(token, "POST", `${url}/pulls`, {
        title: change.pull.title,
        body: change.pull.body,
        head: branch,
        base: head.branch,
      });
      const number = opened?.body?.number;
      const htmlUrl = opened?.body?.html_url;
      if (opened?.status !== 201 || typeof number !== "number" || typeof htmlUrl !== "string") {
        await dropBranch();
        return opened && opened.status < 500 ? refused : null;
      }
      return { outcome: "done", pull: { number, url: htmlUrl } };
    },
  };
}
