import { beforeEach, describe, expect, it } from "vitest";
import { recordGithubFlow, recordGitlabFlow } from "../src/auto-review/flows.js";
import { keepReviewedPaths, type PathReader } from "../src/auto-review/paths.js";
import { scoped } from "../src/db/scoped.js";
import type { ChangedFile } from "../src/platforms/changes.js";
import type { CodePlatform } from "../src/platforms/platform.js";
import { MAX_PULL_PREFIXES, pathPrefixes } from "../src/review-paths.js";
import { db, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// The directories a reviewed pull request changes: which ones are kept,
// read after a kept review once per head, never for another account.

beforeEach(resetDb);

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);

describe("a pull request's directories", () => {
  it("are each file's top-level and second-level directory, most files first", () => {
    expect(
      pathPrefixes(["src/db/a.ts", "src/db/b.ts", "src/app.ts", "web/x/y/z.tsx", "README.md"]),
    ).toEqual(["src", "src/db", "web", "web/x"]);
  });

  it("keep at most MAX_PULL_PREFIXES of them", () => {
    const many = Array.from({ length: 100 }, (_, i) => `d${String(i).padStart(3, "0")}/f.ts`);
    const kept = pathPrefixes(["d099/a.ts", ...many]);
    expect(kept).toHaveLength(MAX_PULL_PREFIXES);
    expect(kept[0]).toBe("d099");
  });
});

function reader(files: () => string[], head: () => string) {
  const asked: string[] = [];
  const platform = {
    kind: "github",
    host: "github.com",
    changes: {
      async changes(token: string, fullName: string, number: number, max?: number) {
        asked.push(`${token} ${fullName}#${number} ${max}`);
        const list: ChangedFile[] = files().map((path) => ({
          path,
          oldPath: path,
          status: "modified",
          hunks: null,
        }));
        return { base: "0".repeat(40), head: head(), files: list, truncated: false };
      },
    },
  } as unknown as CodePlatform;
  const paths: PathReader = {
    db,
    bots: { forRepo: async () => ({ token: "bot-token" }) },
    platforms: [platform],
    env: { MASTER_KEY: "", MASTER_KEY_PREVIOUS: "" } as PathReader["env"],
  };
  return { paths, asked };
}

async function enrolled(githubId: number, login: string, platformRepoId = "11") {
  const { account } = await signIn(githubId, login);
  const data = scoped(db, account.id);
  const repo = { ...rows.reviewRepos(`repo-${login}`), platformRepoId, fullName: "octo/api" };
  await data.insert("reviewRepos", repo);
  const row = await data.findOne("reviewRepos", { id: repo.id });
  if (!row) throw new Error("not enrolled");
  return { data, repo: row };
}

const kept = async (data: ReturnType<typeof scoped>) =>
  (await data.list("pullPaths")).map((r) => `${r.number}@${r.head.slice(0, 1)}:${r.prefix}`).sort();

describe("keeping a reviewed pull request's directories", () => {
  it("reads them as the bot once per head, and replaces them for a newer head", async () => {
    const { data, repo } = await enrolled(1, "octo");
    let files = ["src/db/a.ts", "docs/x.md"];
    let head = H1;
    const { paths, asked } = reader(
      () => files,
      () => head,
    );
    expect(await keepReviewedPaths(paths, { repo, number: 7, head: H1 })).toBe(true);
    expect(await keepReviewedPaths(paths, { repo, number: 7, head: H1 })).toBe(false);
    expect(asked).toEqual(["bot-token octo/api#7 300"]);
    expect(await kept(data)).toEqual(["7@a:docs", "7@a:src", "7@a:src/db"]);
    files = ["web/app.tsx"];
    head = H2;
    expect(await keepReviewedPaths(paths, { repo, number: 7, head: H2 })).toBe(true);
    expect(await kept(data)).toEqual(["7@b:web"]);
  });

  it("keeps at most MAX_PULL_PREFIXES rows for a pull request with many directories", async () => {
    const { data, repo } = await enrolled(1, "octo");
    const { paths } = reader(
      () => Array.from({ length: 80 }, (_, i) => `pkg${i}/src/index.ts`),
      () => H1,
    );
    await keepReviewedPaths(paths, { repo, number: 7, head: H1 });
    expect(await data.list("pullPaths")).toHaveLength(MAX_PULL_PREFIXES);
  });

  it("reads nothing for a head that is not a commit id", async () => {
    const { repo } = await enrolled(1, "octo");
    const { paths, asked } = reader(
      () => ["src/a.ts"],
      () => H1,
    );
    expect(await keepReviewedPaths(paths, { repo, number: 7, head: undefined })).toBe(false);
    expect(await keepReviewedPaths(paths, { repo, number: 7, head: "main" })).toBe(false);
    expect(asked).toEqual([]);
  });

  it("keeps them for the account that enrolled the repository only", async () => {
    const mine = await enrolled(1, "octo");
    const theirs = await enrolled(2, "eve", "12");
    const { paths } = reader(
      () => ["src/db/a.ts"],
      () => H1,
    );
    await keepReviewedPaths(paths, { repo: mine.repo, number: 7, head: H1 });
    expect(await kept(theirs.data)).toEqual([]);
    expect(await theirs.data.pullPaths.headOf(mine.repo.id, 7)).toBeNull();
  });
});

describe("the review webhooks", () => {
  const review = (login: string, type = "User") => ({
    action: "submitted",
    review: { id: 5, user: { login, type }, state: "approved", submitted_at: null },
    pull_request: { number: 7, title: "T", user: { login: "author" }, head: { sha: H1 } },
    repository: { id: 11 },
  });

  it("name the pull request a GitHub review was kept on, not one by the author or a bot", async () => {
    const { repo } = await enrolled(1, "octo");
    const reviewed = await recordGithubFlow(db, "pull_request_review", review("mona"));
    expect(reviewed).toMatchObject({ repo: { id: repo.id }, number: 7, head: H1 });
    expect(await recordGithubFlow(db, "pull_request_review", review("author"))).toBeNull();
    expect(
      await recordGithubFlow(db, "pull_request_review", review("ocra[bot]", "Bot")),
    ).toBeNull();
  });

  it("name the merge request a GitLab approval was kept on", async () => {
    const { repo } = await enrolled(1, "octo");
    const hook = (action: string) => ({
      object_attributes: { iid: 3, action, title: "T", author_id: 1, last_commit: { id: H2 } },
      user: { id: 2, username: "mona" },
    });
    expect(await recordGitlabFlow(db, repo, hook("approved"))).toMatchObject({
      number: 3,
      head: H2,
    });
    expect(await recordGitlabFlow(db, repo, hook("update"))).toBeNull();
  });
});
