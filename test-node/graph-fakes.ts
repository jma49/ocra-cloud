import { vi } from "vitest";
import type { GraphBuilder, GraphBuildInput } from "../src/graph/builder.js";

export const C1 = "1".repeat(40);
export const C2 = "2".repeat(40);
export const C3 = "3".repeat(40);
export const GITLAB = "https://gitlab.example.com";

type Files = Record<string, string>;

/** A pull request as the fake platforms report it: GitHub's file statuses and patches. */
export type FakePull = {
  base: string;
  head: string;
  files: {
    path: string;
    oldPath?: string;
    status: "added" | "removed" | "modified" | "renamed";
    patch?: string;
  }[];
};

/**
 * GitHub's and GitLab's repository APIs for one repository (Octo/API, id
 * 11 on GitHub, project 21 on GitLab): each commit's files by path, with
 * blob ids made from their content. Counts the blobs read.
 */
export function repoFake(
  commits: Record<string, Files>,
  head = C1,
  pulls: Record<number, FakePull> = {},
) {
  const blobs = new Map<string, string>();
  const blobId = (text: string) => {
    const id = Buffer.from(text).toString("hex").padEnd(40, "0").slice(0, 40);
    blobs.set(id, text);
    return id;
  };
  const trees = new Map(
    Object.entries(commits).map(([sha, files]) => [
      sha,
      Object.entries(files).map(([path, text]) => ({ path, sha: blobId(text), size: text.length })),
    ]),
  );
  const reads: string[] = [];
  const blob = (id: string) => {
    reads.push(id);
    const text = blobs.get(id);
    return text === undefined ? new Response(null, { status: 404 }) : new Response(text);
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    const gh = "https://api.github.com/repos/";
    if (url === `${gh}octo/api` || url === `${gh}Octo/API`) {
      return Response.json({ id: 11, full_name: "Octo/API", default_branch: "main" });
    }
    if (url === `${gh}Octo/API/branches/main`) return Response.json({ commit: { sha: head } });
    const tree = /git\/trees\/(\w+)\?recursive=1$/.exec(url)?.[1];
    if (url.startsWith(gh) && tree) {
      const entries = trees.get(tree);
      if (!entries) return new Response(null, { status: 404 });
      return Response.json({
        truncated: false,
        tree: [
          ...entries.map((e) => ({ ...e, type: "blob", mode: "100644" })),
          { path: "vendor/lib", type: "commit", mode: "160000", sha: "f".repeat(40) },
        ],
      });
    }
    const ghBlob = /git\/blobs\/(\w+)$/.exec(url)?.[1];
    if (url.startsWith(gh) && ghBlob) return blob(ghBlob);
    const ghPull =
      /^https:\/\/api\.github\.com\/repos\/Octo\/API\/pulls\/(\d+)(\/files\?per_page=100&page=1)?$/.exec(
        url,
      );
    const pull = ghPull && pulls[Number(ghPull[1])];
    if (ghPull) {
      if (!pull) return new Response(null, { status: 404 });
      if (!ghPull[2]) {
        return Response.json({
          base: { sha: pull.base },
          head: { sha: pull.head },
          changed_files: pull.files.length,
        });
      }
      return Response.json(
        pull.files.map((f) => ({
          filename: f.path,
          ...(f.oldPath ? { previous_filename: f.oldPath } : {}),
          status: f.status,
          changes: f.patch ? 1 : 0,
          ...(f.patch ? { patch: f.patch } : {}),
        })),
      );
    }
    const lab = `${GITLAB}/api/v4/projects/`;
    const labMr = /merge_requests\/(\d+)(\/diffs\?per_page=100&page=1)?$/.exec(url);
    if (url.startsWith(`${lab}group%2Fapi/`) && labMr) {
      const mr = pulls[Number(labMr[1])];
      if (!mr) return new Response(null, { status: 404 });
      if (!labMr[2]) return Response.json({ diff_refs: { base_sha: mr.base, head_sha: mr.head } });
      return Response.json(
        mr.files.map((f) => ({
          old_path: f.oldPath ?? f.path,
          new_path: f.path,
          new_file: f.status === "added",
          deleted_file: f.status === "removed",
          renamed_file: f.status === "renamed",
          diff: f.patch ?? "",
        })),
      );
    }
    if (url === `${lab}group%2Fapi`) {
      return Response.json({ id: 21, path_with_namespace: "group/api", default_branch: "main" });
    }
    if (url === `${lab}21/repository/branches/main`) return Response.json({ commit: { id: head } });
    const labBlob = /repository\/blobs\/(\w+)\/raw$/.exec(url)?.[1];
    if (url.startsWith(lab) && labBlob) return blob(labBlob);
    return new Response(null, { status: 404 });
  });
  return { fetch, reads, blobId };
}

/**
 * The engine's update, reduced to what the server relies on: it reads only
 * the blobs the previous graph lacks and writes a graph of paths to blob ids.
 */
export function fakeBuilder(behaviour: { fail?: boolean; hang?: boolean } = {}) {
  const calls: GraphBuildInput[] = [];
  const builder: GraphBuilder = async (input) => {
    calls.push(input);
    if (behaviour.fail) throw new Error("parser crashed");
    if (behaviour.hang) {
      // The lease may lapse before the builder is called, and then no abort event follows.
      await new Promise((_, reject) => {
        if (input.signal.aborted) reject(input.signal.reason);
        input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      });
    }
    const before = input.previous
      ? (JSON.parse(input.previous) as { files: Record<string, string> }).files
      : {};
    const known = new Set(Object.values(before));
    const files: Record<string, string> = {};
    let parsed = 0;
    let skipped = 0;
    for (const e of input.tree) {
      if (known.has(e.blobId)) {
        files[e.path] = e.blobId;
        continue;
      }
      const bytes = await input.readBlob(e.blobId, e.path);
      if (!bytes) skipped++;
      else {
        files[e.path] = e.blobId;
        parsed++;
      }
    }
    const size = Object.keys(files).length;
    return {
      graph: JSON.stringify({ format: 1, revision: input.revision, files }),
      files: size,
      parsed,
      reused: size - parsed,
      skipped,
    };
  };
  return { builder, calls };
}
