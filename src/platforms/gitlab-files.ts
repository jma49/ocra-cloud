import {
  conflict,
  type FileChangeResult,
  type FileRead,
  guardOf,
  inBatches,
  type RepoFiles,
  refused,
} from "./files.js";
import { fromBase64, toBase64 } from "./fix.js";
import { gitlabHeaders } from "./gitlab-changes.js";
import { platformSend } from "./http.js";

type File = {
  blob_id: string;
  last_commit_id: string;
  size: number;
  encoding: string;
  content: string;
};

const READ_CONCURRENCY = 8;

export function gitlabFiles(origin: string): RepoFiles {
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
    async read(token, repo, commit, paths, maxBytes) {
      const sent = await inBatches(paths, READ_CONCURRENCY, (path) =>
        send(token, "GET", fileUrl(repo.platformRepoId, path, commit)),
      );
      return paths.map((path, i): FileRead => {
        const answer = sent[i];
        if (answer?.status === 404)
          return { path, blobId: null, bytes: undefined, lastCommit: null };
        const file = answer?.status === 200 ? (answer.body as Partial<File> | null) : null;
        if (!file || typeof file.blob_id !== "string") {
          return { path, blobId: "", bytes: undefined, lastCommit: null };
        }
        const bytes =
          file.encoding === "base64" &&
          typeof file.content === "string" &&
          typeof file.size === "number" &&
          file.size <= maxBytes
            ? fromBase64(file.content)
            : undefined;
        return {
          path,
          blobId: file.blob_id,
          bytes,
          // GitLab names the file's last commit here, not when it was made.
          lastCommit:
            typeof file.last_commit_id === "string" ? { sha: file.last_commit_id, at: null } : null,
        };
      });
    },
    async commit(token, head, change): Promise<FileChangeResult | null> {
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
