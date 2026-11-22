import { LEARNINGS_DIR, MAX_LEARNING_BYTES } from "@open-cr-agent/cloud-contract";
import { toBase64 } from "./fix.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import { platformCall, platformSend } from "./http.js";
import {
  guardOf,
  type LearningChangeResult,
  type LearningRead,
  MAX_PROPOSALS,
  PROPOSAL_BRANCH,
  type RepoLearnings,
} from "./learnings.js";

const API = "https://api.github.com";

type Post = (token: string) => <T>(path: string, body: unknown) => Promise<T | null>;
type DirEntry = { type: string; path: string; sha: string };
type Blob = {
  oid: string;
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
type Pull = {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  user: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
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

export function githubLearnings(post: Post): RepoLearnings {
  const repoUrl = (fullName: string) => `${API}/repos/${githubRepoPath(fullName)}`;
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
    async list(token, repo, commit) {
      const sent = await send(
        token,
        "GET",
        `${repoUrl(repo.fullName)}/contents/${LEARNINGS_DIR}?ref=${commit}`,
      );
      if (!sent) return null;
      if (sent.status === 404) return [];
      if (sent.status !== 200) return null;
      // A file where the directory should be lists as an object: no learnings.
      if (!Array.isArray(sent.body)) return [];
      return (sent.body as DirEntry[])
        .filter((e) => e.type === "file")
        .map((e) => ({ path: e.path, blobId: e.sha }));
    },
    async read(token, repo, commit, paths) {
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
      const answer = await post(token)<ReadAnswer>("/graphql", {
        query: readQuery(paths.length),
        variables,
      });
      const repository = answer?.data?.repository;
      if (!repository) return null;
      return paths.map((path, i): LearningRead => {
        const blob = repository[`b${i}`] as Blob | null | undefined;
        const last = repository.at?.[`h${i}`]?.nodes[0];
        const readable =
          blob &&
          !blob.isBinary &&
          !blob.isTruncated &&
          blob.text !== null &&
          blob.byteSize <= MAX_LEARNING_BYTES;
        return {
          path,
          blobId: blob?.oid ?? "",
          bytes: readable && blob.text !== null ? new TextEncoder().encode(blob.text) : undefined,
          lastCommit: last ? { sha: last.oid, at: last.committedDate } : null,
        };
      });
    },
    async proposals(token, repo, base) {
      const pulls = await platformCall<Pull[]>(
        `${repoUrl(repo.fullName)}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100&sort=created&direction=desc`,
        { headers: githubHeaders(token) },
      );
      if (!pulls) return null;
      // Only the repository's own branches: a fork may name a branch anything.
      const own = pulls.filter(
        (p) => p.head.ref.startsWith(PROPOSAL_BRANCH) && p.head.repo?.full_name === repo.fullName,
      );
      return {
        more: own.length > MAX_PROPOSALS,
        proposals: own.slice(0, MAX_PROPOSALS).map((p) => ({
          number: p.number,
          title: p.title,
          url: p.html_url,
          branch: p.head.ref,
          head: p.head.sha,
          author: p.user?.login ?? null,
          createdAt: p.created_at,
        })),
      };
    },
    async change(token, head, change): Promise<LearningChangeResult | null> {
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

const refused: LearningChangeResult = { outcome: "refused", pull: null };
const conflict: LearningChangeResult = { outcome: "conflict", pull: null };
