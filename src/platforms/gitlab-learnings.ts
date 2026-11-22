import {
  LEARNING_PROPOSAL_BRANCH,
  LEARNINGS_DIR,
  MAX_LEARNING_BYTES,
} from "@open-cr-agent/cloud-contract";
import { fromBase64, toBase64 } from "./fix.js";
import { gitlabHeaders } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";
import {
  guardOf,
  inBatches,
  type LearningChangeResult,
  type LearningEntry,
  MAX_PROPOSALS,
  type RepoLearnings,
} from "./learnings.js";

type Node = { id: string; path: string; type: string; mode: string };
type File = {
  blob_id: string;
  last_commit_id: string;
  size: number;
  encoding: string;
  content: string;
};
type MergeRequest = {
  iid: number;
  title: string;
  web_url: string;
  created_at: string;
  sha: string;
  source_branch: string;
  source_project_id: number;
  author: { username: string } | null;
};

const PER_PAGE = 100;
/** The contract's 500 learnings, at 100 a page. */
const MAX_TREE_PAGES = 5;
const READ_CONCURRENCY = 8;
const REGULAR = new Set(["100644", "100755"]);

export function gitlabLearnings(origin: string): RepoLearnings {
  const api = `${origin}/api/v4`;
  const project = (id: string) => `${api}/projects/${encodeURIComponent(id)}`;
  const send = (token: string, method: string, url: string, body?: unknown) =>
    platformSend<Record<string, unknown>>(url, {
      method,
      headers: {
        ...gitlabHeaders(token),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const fileUrl = (id: string, path: string, ref: string) =>
    `${project(id)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  return {
    async list(token, repo, commit) {
      const entries: LearningEntry[] = [];
      for (let page = 1; page <= MAX_TREE_PAGES; page++) {
        const sent = await send(
          token,
          "GET",
          `${project(repo.platformRepoId)}/repository/tree?path=${encodeURIComponent(LEARNINGS_DIR)}&ref=${commit}&per_page=${PER_PAGE}&page=${page}`,
        );
        if (!sent) return null;
        if (sent.status === 404) return entries;
        if (sent.status !== 200 || !Array.isArray(sent.body)) return null;
        const nodes = sent.body as Node[];
        for (const n of nodes) {
          if (n.type === "blob" && REGULAR.has(n.mode))
            entries.push({ path: n.path, blobId: n.id });
        }
        if (nodes.length < PER_PAGE) break;
      }
      return entries;
    },
    async read(token, repo, commit, paths) {
      const files = await inBatches(paths, READ_CONCURRENCY, (path) =>
        platformCall<File>(fileUrl(repo.platformRepoId, path, commit), {
          headers: gitlabHeaders(token),
        }),
      );
      return paths.map((path, i) => {
        const file = files[i];
        const bytes =
          file && file.encoding === "base64" && file.size <= MAX_LEARNING_BYTES
            ? fromBase64(file.content)
            : undefined;
        return {
          path,
          blobId: file?.blob_id ?? "",
          bytes,
          // GitLab names the file's last commit here, not when it was made.
          lastCommit: file ? { sha: file.last_commit_id, at: null } : null,
        };
      });
    },
    async proposals(token, repo, base) {
      const mrs = await platformCall<MergeRequest[]>(
        `${project(repo.platformRepoId)}/merge_requests?state=opened&target_branch=${encodeURIComponent(base)}&per_page=100&order_by=created_at`,
        { headers: gitlabHeaders(token) },
      );
      if (!mrs) return null;
      // Only the project's own branches: a fork may name a branch anything.
      const own = mrs.filter(
        (m) =>
          m.source_branch.startsWith(LEARNING_PROPOSAL_BRANCH) &&
          String(m.source_project_id) === repo.platformRepoId,
      );
      return {
        more: own.length > MAX_PROPOSALS,
        proposals: own.slice(0, MAX_PROPOSALS).map((m) => ({
          number: m.iid,
          title: m.title,
          url: m.web_url,
          branch: m.source_branch,
          head: m.sha,
          author: m.author?.username ?? null,
          createdAt: m.created_at,
        })),
      };
    },
    async change(token, head, change): Promise<LearningChangeResult | null> {
      const id = head.platformRepoId;
      const read = await send(token, "GET", fileUrl(id, change.path, head.commit));
      if (!read) return null;
      if (read.status !== 200 && read.status !== 404) return read.status < 500 ? refused : null;
      const body = read.body as Partial<File> | null;
      const found =
        read.status === 404 || typeof body?.blob_id !== "string"
          ? ("missing" as const)
          : { blobId: body.blob_id };
      if (guardOf(found, change.expected) === "conflict") return conflict;
      const action = !change.content ? "delete" : found === "missing" ? "create" : "update";
      // last_commit_id: GitLab refuses the commit when the file changed since it was read;
      // start_sha makes the new branch at the commit that was read.
      const committed = await send(token, "POST", `${project(id)}/repository/commits`, {
        branch: change.pull?.branch ?? head.branch,
        ...(change.pull ? { start_sha: head.commit } : {}),
        commit_message: change.message,
        actions: [
          {
            action,
            file_path: change.path,
            ...(change.content ? { content: toBase64(change.content), encoding: "base64" } : {}),
            ...(action === "create" ? {} : { last_commit_id: body?.last_commit_id }),
          },
        ],
      });
      if (!committed) return null;
      if (committed.status < 200 || committed.status >= 300) {
        // 400: the file is not as read (changed, or created since), the request being well formed.
        if (committed.status === 400) return conflict;
        return committed.status < 500 ? refused : null;
      }
      if (!change.pull) return { outcome: "done", pull: null };
      const opened = await send(token, "POST", `${project(id)}/merge_requests`, {
        source_branch: change.pull.branch,
        target_branch: head.branch,
        title: change.pull.title,
        description: change.pull.body,
        remove_source_branch: true,
      });
      const iid = opened?.body?.iid;
      const webUrl = opened?.body?.web_url;
      if (opened?.status !== 201 || typeof iid !== "number" || typeof webUrl !== "string") {
        await send(
          token,
          "DELETE",
          `${project(id)}/repository/branches/${encodeURIComponent(change.pull.branch)}`,
        );
        return opened && opened.status < 500 ? refused : null;
      }
      return { outcome: "done", pull: { number: iid, url: webUrl } };
    },
  };
}

const refused: LearningChangeResult = { outcome: "refused", pull: null };
const conflict: LearningChangeResult = { outcome: "conflict", pull: null };
