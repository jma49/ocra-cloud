import {
  type ChangedFile,
  hunksOf,
  lineCounts,
  MAX_CHANGED_FILES,
  type PullDiffs,
  withinBudget,
} from "./changes.js";
import { platformCall } from "./http.js";

const PER_PAGE = 100;

export type DiffRefs = { base_sha: string; head_sha: string; start_sha: string };
type MergeRequest = { diff_refs: DiffRefs | null };
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

export const gitlabHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/json",
});

export const mergeRequestUrl = (origin: string, fullName: string, number: number) =>
  `${origin}/api/v4/projects/${encodeURIComponent(fullName)}/merge_requests/${number}`;

async function listDiffs(origin: string, token: string, fullName: string, number: number) {
  const base = mergeRequestUrl(origin, fullName, number);
  const mr = await platformCall<MergeRequest>(base, { headers: gitlabHeaders(token) });
  if (!mr?.diff_refs) return null;
  const diffs: Diff[] = [];
  let more = true;
  for (let page = 1; more && diffs.length < MAX_CHANGED_FILES; page++) {
    const listed = await platformCall<Diff[]>(`${base}/diffs?per_page=${PER_PAGE}&page=${page}`, {
      headers: gitlabHeaders(token),
    });
    if (!listed) return null;
    diffs.push(...listed);
    more = listed.length === PER_PAGE;
  }
  return {
    base: mr.diff_refs.base_sha,
    head: mr.diff_refs.head_sha,
    diffs: diffs.slice(0, MAX_CHANGED_FILES),
    truncated: more,
  };
}

const where = (d: Diff) => ({ path: d.new_path, oldPath: d.old_path, status: statusOf(d) });

export function gitlabChanges(origin: string): PullDiffs {
  return {
    async changes(token, fullName, number) {
      const listed = await listDiffs(origin, token, fullName, number);
      if (!listed) return null;
      const { diffs, ...rest } = listed;
      return {
        ...rest,
        files: diffs.map((d) => {
          const file = where(d);
          // An empty diff is a rename or an empty file, or one GitLab collapsed.
          const hunks = d.diff ? hunksOf(d.diff) : file.status === "modified" ? null : [];
          return { ...file, hunks };
        }),
      };
    },
    async patches(token, fullName, number) {
      const listed = await listDiffs(origin, token, fullName, number);
      if (!listed) return null;
      const { diffs, ...rest } = listed;
      return withinBudget({
        ...rest,
        files: diffs.map((d) => ({
          ...where(d),
          ...lineCounts(d.diff),
          patch: d.diff || null,
        })),
      });
    },
  };
}
