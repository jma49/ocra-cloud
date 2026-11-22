import { describe, expect, it } from "vitest";
import { ownersOfPath, parseCodeOwners, patternRegex } from "../src/codeowners.js";
import { rankReviewers, withLoad } from "../src/reviewer-rank.js";

// CODEOWNERS read as each platform documents it, and the ranking of the
// suggested reviewers that follows from it.

const names = (text: string, flavor: "github" | "gitlab", path: string) =>
  ownersOfPath(parseCodeOwners(text, flavor), path).map((o) => `${o.kind}:${o.name}`);

describe("CODEOWNERS patterns", () => {
  const matches = (pattern: string, path: string, flavor: "github" | "gitlab" = "github") =>
    patternRegex(pattern, flavor)?.test(path) ?? false;

  it("reads a name without a slash at any depth, and everything under a directory", () => {
    expect(matches("*.js", "src/a/b.js")).toBe(true);
    expect(matches("*.js", "src/a/b.ts")).toBe(false);
    expect(matches("build/", "src/build/x.txt")).toBe(true);
    expect(matches("/build/", "src/build/x.txt")).toBe(false);
    expect(matches("/build/", "build/x/y.txt")).toBe(true);
    expect(matches("apps", "apps/web/index.ts")).toBe(true);
  });

  it("keeps `docs/*` to docs' own files, and lets `**` cross directories", () => {
    expect(matches("docs/*", "docs/start.md")).toBe(true);
    expect(matches("docs/*", "docs/guide/start.md")).toBe(false);
    expect(matches("docs/**/*.md", "docs/a/b/c.md")).toBe(true);
    expect(matches("**/logs", "deep/down/logs/x.log")).toBe(true);
    expect(matches("?.txt", "a.txt")).toBe(true);
  });

  it("anchors a path with an inner slash on GitHub, only a leading slash on GitLab", () => {
    expect(matches("src/api", "src/api/x.ts")).toBe(true);
    expect(matches("src/api", "lib/src/api/x.ts")).toBe(false);
    expect(matches("src/api", "lib/src/api/x.ts", "gitlab")).toBe(true);
    expect(matches("/src/api", "lib/src/api/x.ts", "gitlab")).toBe(false);
  });

  it("does not read a negation, which neither platform has", () => {
    expect(patternRegex("!docs/", "github")).toBeUndefined();
    expect(names("* @all\n!docs/ @nobody", "github", "docs/a.md")).toEqual(["user:all"]);
  });
});

describe("CODEOWNERS rules", () => {
  it("lets the last matching rule win on GitHub, an ownerless one clearing it", () => {
    const text = [
      "# comment",
      "*       @everyone",
      "/src/   @octo/core @lead",
      "/src/vendor/",
      "*.md    docs@example.com @writer # trailing",
    ].join("\n");
    expect(names(text, "github", "README.md")).toEqual(["email:docs@example.com", "user:writer"]);
    expect(names(text, "github", "src/app.ts")).toEqual(["team:octo/core", "user:lead"]);
    expect(names(text, "github", "src/vendor/lib.js")).toEqual([]);
    expect(names(text, "github", "other/x.ts")).toEqual(["user:everyone"]);
  });

  it("does not read GitHub lines as GitLab sections", () => {
    expect(names("[Docs] @a\n*.md @b", "github", "x.md")).toEqual(["user:b"]);
  });

  it("adds up GitLab's sections, the last match in each, defaults for ownerless entries", () => {
    const text = [
      "* @fallback",
      "[Backend] @backend-lead",
      "/api/ @api-owner",
      "/api/internal/",
      "^[Docs][2] @docs/team",
      "*.md",
      "[frontend]",
      "/web/ @web @@maintainer",
      "[Frontend]",
      "/web/legacy/ @old",
    ].join("\n");
    expect(names(text, "gitlab", "api/internal/x.go")).toEqual([
      "user:fallback",
      "user:backend-lead",
    ]);
    expect(names(text, "gitlab", "api/README.md")).toEqual([
      "user:fallback",
      "user:api-owner",
      "team:docs/team",
    ]);
    // Sections named alike, whatever their case, are one section.
    expect(names(text, "gitlab", "web/legacy/a.ts")).toEqual(["user:fallback", "user:old"]);
    expect(names(text, "gitlab", "web/a.ts")).toEqual([
      "user:fallback",
      "user:web",
      "role:maintainer",
    ]);
  });

  it("reads an escaped space or hash as part of the path", () => {
    expect(names("my\\ docs/ @a\n\\#notes @b", "github", "my docs/x.md")).toEqual(["user:a"]);
    expect(names("my\\ docs/ @a\n\\#notes @b", "github", "#notes")).toEqual(["user:b"]);
  });
});

describe("reviewer ranking", () => {
  const owner = (name: string, kind: "user" | "team" = "user") => ({ name, kind });

  it("puts code owners first, then recent reviewers, without the author or bots", () => {
    const ranked = rankReviewers({
      author: "Alice",
      requested: ["carol"],
      owners: [
        [owner("bob"), owner("octo/core", "team"), owner("alice")],
        [owner("Bob"), owner("carol")],
      ],
      history: [
        { login: "dave", reviews: 14 },
        { login: "carol", reviews: 3 },
        { login: "ocra[bot]", reviews: 30 },
        { login: "project_7_bot_ab12", reviews: 30 },
        { login: "ALICE", reviews: 9 },
      ],
    });
    expect(ranked.map((r) => [r.login, r.score, r.reasons, r.alreadyRequested])).toEqual([
      ["carol", 14, ["codeowner", "recent_reviewer"], true],
      ["bob", 12, ["codeowner"], false],
      ["dave", 10, ["recent_reviewer"], false],
    ]);
  });

  it("lowers busy reviewers by their open review requests, never below zero", () => {
    const ranked = rankReviewers({
      author: null,
      requested: [],
      owners: [[owner("a")]],
      history: [
        { login: "b", reviews: 10 },
        { login: "c", reviews: 2 },
      ],
    });
    const loaded = withLoad(ranked, [9, 0, null]);
    expect(loaded.map((r) => [r.login, r.score, r.load])).toEqual([
      ["b", 10, 0],
      ["a", 6, 9],
      ["c", 2, null],
    ]);
    expect(withLoad(ranked.slice(2), [40])[0]?.score).toBe(0);
  });
});
