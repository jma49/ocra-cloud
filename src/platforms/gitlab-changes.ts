import { type ChangedFile, hunksOf, MAX_CHANGED_FILES, type PullDiffs } from "./changes.js";
import { platformCall } from "./http.js";

const PER_PAGE = 100;

type MergeRequest = { diff_refs: { base_sha: string; head_sha: string } | null };
type Diff = {
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  diff: string;
};

const statusOf = (d: Diff): ChangedFile["status"] =>
  d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified";

export function gitlabChanges(origin: string): PullDiffs {
  const api = `${origin}/api/v4`;
  const headers = (token: string) => ({
    authorization: `Bearer ${token}`,
    accept: "application/json",
  });
  return {
    async changes(token, fullName, number) {
      const base = `${api}/projects/${encodeURIComponent(fullName)}/merge_requests/${number}`;
      const mr = await platformCall<MergeRequest>(base, { headers: headers(token) });
      if (!mr?.diff_refs) return null;
      const files: ChangedFile[] = [];
      let more = true;
      for (let page = 1; more && files.length < MAX_CHANGED_FILES; page++) {
        const listed = await platformCall<Diff[]>(
          `${base}/diffs?per_page=${PER_PAGE}&page=${page}`,
          { headers: headers(token) },
        );
        if (!listed) return null;
        for (const d of listed) {
          const status = statusOf(d);
          files.push({
            path: d.new_path,
            oldPath: d.old_path,
            status,
            // An empty diff is a rename or an empty file, or one GitLab collapsed.
            hunks: d.diff ? hunksOf(d.diff) : status === "modified" ? null : [],
          });
        }
        more = listed.length === PER_PAGE;
      }
      return {
        base: mr.diff_refs.base_sha,
        head: mr.diff_refs.head_sha,
        files: files.slice(0, MAX_CHANGED_FILES),
        truncated: more,
      };
    },
  };
}
