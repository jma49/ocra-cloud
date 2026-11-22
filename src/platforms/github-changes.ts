import { type ChangedFile, hunksOf, MAX_CHANGED_FILES, type PullDiffs } from "./changes.js";
import { platformCall } from "./http.js";

const API = "https://api.github.com";
const PER_PAGE = 100;

type Pull = { base: { sha: string }; head: { sha: string }; changed_files: number };
type File = {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  changes: number;
  patch?: string;
};

const STATUS = {
  added: "added",
  copied: "added",
  removed: "removed",
  renamed: "renamed",
  modified: "modified",
  changed: "modified",
  unchanged: "modified",
} as const satisfies Record<File["status"], ChangedFile["status"]>;

export function githubChanges(): PullDiffs {
  const headers = (token: string) => ({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "ocra-cloud",
  });
  const path = (fullName: string) => fullName.split("/").map(encodeURIComponent).join("/");
  return {
    async changes(token, fullName, number) {
      const base = `${API}/repos/${path(fullName)}/pulls/${number}`;
      const pull = await platformCall<Pull>(base, { headers: headers(token) });
      if (!pull) return null;
      const wanted = Math.min(pull.changed_files, MAX_CHANGED_FILES);
      const files: ChangedFile[] = [];
      for (let page = 1; files.length < wanted; page++) {
        const listed = await platformCall<File[]>(
          `${base}/files?per_page=${PER_PAGE}&page=${page}`,
          { headers: headers(token) },
        );
        if (!listed) return null;
        for (const f of listed) {
          files.push({
            path: f.filename,
            oldPath: f.previous_filename ?? f.filename,
            status: STATUS[f.status],
            hunks: f.patch !== undefined ? hunksOf(f.patch) : f.changes === 0 ? [] : null,
          });
        }
        if (listed.length < PER_PAGE) break;
      }
      return {
        base: pull.base.sha,
        head: pull.head.sha,
        files: files.slice(0, MAX_CHANGED_FILES),
        truncated: pull.changed_files > files.length,
      };
    },
  };
}
