import {
  avatarOf,
  branchesOf,
  type ChangedFile,
  hunksOf,
  MAX_CHANGED_FILES,
  type PatchedFile,
  type PullDiffs,
  type PullPatches,
  withinBudget,
} from "./changes.js";
import type { GithubHost } from "./github-host.js";
import { platformCall } from "./http.js";

const PER_PAGE = 100;

type Pull = {
  title?: string;
  user?: { login: string; avatar_url?: string } | null;
  html_url?: string;
  state?: "open" | "closed";
  merged?: boolean;
  base: { sha: string; ref?: string };
  head: { sha: string; ref?: string };
  changed_files: number;
  updated_at?: string;
};
export type GithubFile = {
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
} as const satisfies Record<GithubFile["status"], ChangedFile["status"]>;

export const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "ocra-cloud",
});

export const githubRepoPath = (fullName: string) =>
  fullName.split("/").map(encodeURIComponent).join("/");

async function listFiles(
  host: GithubHost,
  token: string,
  fullName: string,
  number: number,
  max = MAX_CHANGED_FILES,
) {
  const base = `${host.api}/repos/${githubRepoPath(fullName)}/pulls/${number}`;
  const pull = await platformCall<Pull>(base, { headers: githubHeaders(token) });
  if (!pull) return null;
  const wanted = Math.min(pull.changed_files, max);
  const files: GithubFile[] = [];
  for (let page = 1; files.length < wanted; page++) {
    const listed = await platformCall<GithubFile[]>(
      `${base}/files?per_page=${PER_PAGE}&page=${page}`,
      {
        headers: githubHeaders(token),
      },
    );
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
    branches: branchesOf(pull.head.ref, pull.base.ref),
    authorAvatar: avatarOf(pull.user?.avatar_url),
    files: files.slice(0, max),
    truncated: pull.changed_files > Math.min(files.length, max),
  };
}

const where = (f: GithubFile) => ({
  path: f.filename,
  oldPath: f.previous_filename ?? f.filename,
  status: STATUS[f.status],
});

export const patchedFile = (f: GithubFile): PatchedFile => ({
  ...where(f),
  additions: f.additions,
  deletions: f.deletions,
  patch: f.patch ?? null,
  version: f.sha ?? null,
});

export function githubChanges(host: GithubHost): PullDiffs {
  return {
    async changes(token, fullName, number, maxFiles) {
      const listed = await listFiles(host, token, fullName, number, maxFiles);
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
      const listed = await listFiles(host, token, fullName, number);
      if (!listed) return null;
      const files = listed.files.map(patchedFile);
      return withinBudget({ ...listed, files } satisfies PullPatches);
    },
  };
}
