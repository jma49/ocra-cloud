import {
  type ChangedFile,
  hunksOf,
  MAX_CHANGED_FILES,
  type PatchedFile,
  type PullDiffs,
  type PullPatches,
  withinBudget,
} from "./changes.js";
import { platformCall } from "./http.js";

const API = "https://api.github.com";
const PER_PAGE = 100;

type Pull = {
  title?: string;
  user?: { login: string } | null;
  html_url?: string;
  state?: "open" | "closed";
  merged?: boolean;
  base: { sha: string };
  head: { sha: string };
  changed_files: number;
  updated_at?: string;
};
type File = {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  sha?: string;
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

export const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "ocra-cloud",
});

export const githubRepoPath = (fullName: string) =>
  fullName.split("/").map(encodeURIComponent).join("/");

async function listFiles(token: string, fullName: string, number: number, max = MAX_CHANGED_FILES) {
  const base = `${API}/repos/${githubRepoPath(fullName)}/pulls/${number}`;
  const pull = await platformCall<Pull>(base, { headers: githubHeaders(token) });
  if (!pull) return null;
  const wanted = Math.min(pull.changed_files, max);
  const files: File[] = [];
  for (let page = 1; files.length < wanted; page++) {
    const listed = await platformCall<File[]>(`${base}/files?per_page=${PER_PAGE}&page=${page}`, {
      headers: githubHeaders(token),
    });
    if (!listed) return null;
    files.push(...listed);
    if (listed.length < PER_PAGE) break;
  }
  return {
    title: pull.title ?? null,
    author: pull.user?.login ?? null,
    url: pull.html_url ?? null,
    state: pull.merged ? ("merged" as const) : (pull.state ?? null),
    base: pull.base.sha,
    head: pull.head.sha,
    updatedAt: pull.updated_at ?? null,
    files: files.slice(0, max),
    truncated: pull.changed_files > Math.min(files.length, max),
  };
}

const where = (f: File) => ({
  path: f.filename,
  oldPath: f.previous_filename ?? f.filename,
  status: STATUS[f.status],
});

export function githubChanges(): PullDiffs {
  return {
    async changes(token, fullName, number, maxFiles) {
      const listed = await listFiles(token, fullName, number, maxFiles);
      if (!listed) return null;
      return {
        ...listed,
        files: listed.files.map((f) => ({
          ...where(f),
          hunks: f.patch !== undefined ? hunksOf(f.patch) : f.changes === 0 ? [] : null,
        })),
      };
    },
    async patches(token, fullName, number) {
      const listed = await listFiles(token, fullName, number);
      if (!listed) return null;
      const files = listed.files.map(
        (f): PatchedFile => ({
          ...where(f),
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? null,
          version: f.sha ?? null,
        }),
      );
      return withinBudget({ ...listed, files } satisfies PullPatches);
    },
  };
}
