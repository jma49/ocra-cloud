import { beforeEach, describe, expect, it } from "vitest";
import { assign, settle } from "../src/auto-review/work.js";
import { scoped } from "../src/db/scoped.js";
import type { FileRead } from "../src/platforms/files.js";
import { db, resetDb, signIn } from "./helpers.js";

// A hosted review and the repository's own .ocra/config.json: read at the
// default branch's head of the enrolled repository, never at the pull
// request's head or from a fork, checked with the engine's schema, and
// only its allowed settings passed on, under the server's.

beforeEach(resetDb);

const CALLS = 1000;
const DEFAULT_HEAD = "d".repeat(40);
const PR_HEAD = "a".repeat(40);
const now = new Date("2026-03-04T10:00:00Z");

/** Files by "<repository>@<commit>"; the pull request's own commit and a fork have theirs too. */
function fakePlatform(files: Record<string, string>) {
  const reads: { repo: string; commit: string; maxBytes: number }[] = [];
  const platform = {
    kind: "github",
    host: "github.com",
    url: "https://github.com",
    contents: {
      head: async (_token: string, fullName: string) => ({
        platformRepoId: "11",
        fullName,
        branch: "main",
        commit: DEFAULT_HEAD,
      }),
    },
    files: {
      read: async (
        _token: string,
        repo: { fullName: string },
        commit: string,
        paths: string[],
        maxBytes: number,
      ): Promise<FileRead[]> => {
        reads.push({ repo: repo.fullName, commit, maxBytes });
        return paths.map((path) => {
          const text = files[`${repo.fullName}@${commit}`];
          if (text === undefined) return { path, blobId: null, bytes: undefined, lastCommit: null };
          const bytes = new TextEncoder().encode(text);
          return {
            path,
            blobId: "b".repeat(40),
            bytes: bytes.byteLength <= maxBytes ? bytes : undefined,
            lastCommit: null,
          };
        });
      },
    },
  };
  return { platform, reads };
}

async function review(files: Record<string, string>, profile?: "quiet") {
  const accountId = (await signIn(1, "me")).account.id;
  const data = scoped(db, accountId);
  const id =
    (await data.autoReview.enroll(
      { platform: "github", host: "github.com", platformRepoId: "11", fullName: "octo/api" },
      100,
    )) ?? "";
  if (profile) await data.update("reviewRepos", id, { reviewProfile: profile });
  await data.autoReview.queue(id, 7, PR_HEAD, now);
  const { platform, reads } = fakePlatform(files);
  const source = {
    db,
    platforms: [platform] as never,
    bots: { forRepo: async () => ({ token: "t", login: "ocra[bot]" }) } as never,
    publicUrl: "https://ocra.test",
    dailyCalls: CALLS,
    now: () => now,
  };
  const work = await assign(source, "review");
  if (!work || work === "refused") throw new Error("no assignment");
  await settle(source, work, null, now);
  const [job] = await data.autoReview.latestJobs();
  return { config: work.config, reads, job };
}

const at = (commit: string, config: unknown) => ({
  [`octo/api@${commit}`]: JSON.stringify(config),
});

describe("a hosted review and the repository's configuration", () => {
  it("applies the allowed settings of the default branch's file", async () => {
    const { config, job } = await review(
      at(DEFAULT_HEAD, {
        include: ["gen/**"],
        exclude: ["legacy/**"],
        verify: false,
        maxTasks: 20,
        reviewers: { docs: { enabled: false, minTier: "lite" } },
        github: { requestChanges: true },
      }),
    );
    expect(config).toMatchObject({
      include: ["gen/**"],
      exclude: ["legacy/**"],
      verify: false,
      maxTasks: 20,
      reviewers: { docs: { enabled: false, minTier: "lite" } },
      github: { requestChanges: true, botLogin: "ocra[bot]" },
    });
    expect(job).toMatchObject({ state: "done", error: null });
  });

  it("drops every setting outside the allowed ones", async () => {
    const { config } = await review(
      at(DEFAULT_HEAD, {
        plugins: ["./evil.js"],
        pluginSettings: { evil: { run: true } },
        runtime: "opencode",
        extends: "https://config.example.com/ocra.json",
        models: { standard: "openai/gpt-5" },
        providers: {
          mine: {
            type: "openai-compatible",
            baseUrl: "https://llm.example.com/v1",
            models: { m: { input: 1, output: 1 } },
          },
        },
        projectDocs: ["docs"],
        concurrency: 32,
        runTimeoutMinutes: 600,
        reviewers: { security: { models: "openai/gpt-5", minTier: "full" } },
        github: { botLogin: "someone-else" },
        exclude: [],
      }),
    );
    expect(config).toEqual({
      runtime: "direct",
      exclude: [],
      reviewers: { security: { minTier: "full" } },
      github: { botLogin: "ocra[bot]" },
      maxCostUsd: 10,
    });
  });

  it("reads the default branch's head, never the pull request's", async () => {
    const { config, reads } = await review(at(PR_HEAD, { include: ["from-the-pull/**"] }));
    expect(reads).toEqual([{ repo: "octo/api", commit: DEFAULT_HEAD, maxBytes: 64 * 1024 }]);
    expect(config).not.toHaveProperty("include");
  });

  it("reads the enrolled repository, never a fork a pull request comes from", async () => {
    const { config, reads } = await review({
      ...at(DEFAULT_HEAD, { judge: false }),
      [`fork/api@${DEFAULT_HEAD}`]: JSON.stringify({ include: ["from-the-fork/**"] }),
    });
    expect(reads.map((r) => r.repo)).toEqual(["octo/api"]);
    expect(config).toMatchObject({ judge: false });
    expect(config).not.toHaveProperty("include");
  });

  it("keeps the server's settings over the file's", async () => {
    const { config } = await review(
      at(DEFAULT_HEAD, {
        maxCostUsd: 50,
        showPreExisting: true,
        reviewers: { performance: { enabled: true, minTier: "lite" } },
      }),
      "quiet",
    );
    expect(config).toMatchObject({
      maxCostUsd: 10,
      showPreExisting: false,
      reviewers: { performance: { enabled: false, minTier: "lite" } },
    });
  });

  it("takes the file's spend limit where it is the lower", async () => {
    const { config } = await review(at(DEFAULT_HEAD, { maxCostUsd: 0.5 }));
    expect(config).toMatchObject({ maxCostUsd: 0.5 });
  });

  it("reviews without a file that is not valid, and notes it on the job", async () => {
    const { config, job } = await review(
      at(DEFAULT_HEAD, { include: ["gen/**"], concurrency: "many" }),
    );
    expect(config).toEqual({
      runtime: "direct",
      github: { botLogin: "ocra[bot]" },
      maxCostUsd: 10,
    });
    expect(job).toMatchObject({ state: "done", error: "repo_config_ignored" });
  });

  it("reviews without a file over the size cap, and notes it on the job", async () => {
    const big = {
      include: ["gen/**"],
      exclude: Array.from({ length: 7000 }, (_, i) => `x${i}/**`),
    };
    const { config, job } = await review(at(DEFAULT_HEAD, big));
    expect(config).not.toHaveProperty("include");
    expect(job).toMatchObject({ state: "done", error: "repo_config_ignored" });
  });
});
