import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathMatcher, pathsHold } from "../src/automations/paths.js";
import { MAX_ATTEMPTS, resultOf, retryOf } from "../src/automations/run.js";
import { claimAutomationRetry } from "../src/db/automations.js";
import { scoped } from "../src/db/scoped.js";
import { outcomeOf } from "../src/platforms/actions.js";
import { upload } from "./finding-uploads.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";
import { rows } from "./table-rows.js";

// A rule on the files a pull request changes: its globs read as .gitignore
// reads them, checked when saved, tried by a dry run on listed paths, and
// skipped, never matched, when the files cannot be read. A write the
// platform did not answer is tried again, each attempt claimed once.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

type Auth = Record<string, string>;
const addRule = (auth: Auth, json: Record<string, unknown>) =>
  call("/api/automations/rules", { method: "POST", auth, json });
const docsOnly = {
  name: "docs only",
  trigger: "queued",
  conditions: { paths: { include: ["docs/", "*.md"], every: true } },
  actions: [{ kind: "skip_review" }],
};

describe("a path glob", () => {
  it("matches as .gitignore does, case-folded", () => {
    const m = pathMatcher(["*.md", "docs/", "/build", "src/**/gen/*.ts", ".github"]);
    expect(m("README.md")).toBe(true);
    expect(m("a/b/NOTES.MD")).toBe(true);
    expect(m("docs/guide/intro.mdx")).toBe(true);
    expect(m("build/out.js")).toBe(true);
    expect(m("pkg/build/out.js")).toBe(false);
    expect(m("src/gen/a.ts")).toBe(true);
    expect(m("src/x/y/gen/a.ts")).toBe(true);
    expect(m("src/x/gen/a.tsx")).toBe(false);
    expect(m(".github/workflows/ci.yml")).toBe(true);
    expect(m("src/docs.ts")).toBe(false);
  });

  it("takes time bounded by its length on globs that defeat backtracking", () => {
    const started = Date.now();
    const m = pathMatcher([`${"**/".repeat(50)}${"*a".repeat(50)}b`]);
    expect(m(`${"a/".repeat(200)}${"a".repeat(200)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("holds for any or every selected file, and is undecided past the files read", () => {
    const rule = { include: ["docs/"], exclude: ["docs/drafts/"] };
    const read = (paths: string[], truncated = false) => ({ paths, truncated });
    expect(pathsHold(rule, read(["src/a.ts", "docs/a.md"]))).toBe(true);
    expect(pathsHold(rule, read(["docs/drafts/a.md"]))).toBe(false);
    expect(pathsHold(rule, read(["src/a.ts"], true))).toBe("too_many_files");
    expect(pathsHold(rule, read(["docs/a.md"], true))).toBe(true);
    const every = { ...rule, every: true };
    expect(pathsHold(every, read(["docs/a.md", "src/a.ts"], true))).toBe(false);
    expect(pathsHold(every, read(["docs/a.md"], true))).toBe("too_many_files");
    expect(pathsHold(every, read(["docs/a.md"]))).toBe(true);
    expect(pathsHold(every, read([]))).toBe(false);
    expect(pathsHold({ exclude: ["*.lock"] }, read(["package.lock"]))).toBe(false);
    expect(pathsHold(rule, null)).toBe("paths_unavailable");
  });
});

describe("a rule's paths", () => {
  it("are refused when they are not globs of *, ? and **, or too many", async () => {
    const { auth } = await signIn(1, "octo");
    const many = Array.from({ length: 21 }, (_, i) => `d${i}/`);
    for (const paths of [
      {},
      { include: [] },
      { include: ["[ab].ts"] },
      { include: ["{a,b}.ts"] },
      { exclude: ["!keep"] },
      { include: ["a\\b"] },
      { include: ["x".repeat(201)] },
      { include: many },
      { include: ["a"], regex: ".*" },
    ]) {
      const res = await addRule(auth, { ...docsOnly, conditions: { paths } });
      expect(res.status, JSON.stringify(paths)).toBe(400);
    }
    expect((await addRule(auth, docsOnly)).status).toBe(200);
  });

  it("are tried by a dry run on the paths listed, and skipped without them", async () => {
    const { auth } = await signIn(1, "octo");
    const { rule } = (await (await addRule(auth, docsOnly)).json()) as { rule: { id: string } };
    const dry = async (pull: Record<string, unknown>) =>
      (
        await call("/api/automations/dry-run", {
          method: "POST",
          auth,
          json: { trigger: "queued", pull },
        })
      ).json();
    expect(await dry({ paths: ["docs/a.md", "README.md"] })).toMatchObject({
      matches: [{ name: "docs only", actions: ["skip_review"] }],
      skipped: [],
    });
    expect(await dry({ paths: ["docs/a.md", "src/a.ts"] })).toEqual({ matches: [], skipped: [] });
    expect(await dry({})).toEqual({
      matches: [],
      skipped: [{ ruleId: rule.id, name: "docs only", reason: "paths_unavailable" }],
    });
  });

  it("whose files cannot be read leave the rule skipped in the run log, never matched", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    await addRule(web.auth, {
      name: "api changes",
      trigger: "reviewed",
      conditions: { paths: { include: ["src/api/"] } },
      actions: [{ kind: "comment", body: "API changed" }],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 502 }));
    const json = {
      ...upload("run-paths", []),
      pullRequest: {
        repository: "https://github.com/octo/api",
        number: 7,
        headSha: "a".repeat(40),
      },
    };
    expect((await call("/api/reviews", { method: "POST", auth: cli.auth, json })).status).toBe(200);
    const { runs } = (await (await call("/api/automations/runs", { auth: web.auth })).json()) as {
      runs: unknown[];
    };
    expect(runs).toEqual([
      expect.objectContaining({
        ruleName: "api changes",
        outcome: "skipped",
        reason: "paths_unavailable",
        actions: [],
        retryAt: null,
      }),
    ]);
  });
});

describe("a write the platform did not answer", () => {
  it("is unreached on a 429 or 5xx, refused on another 4xx", () => {
    expect(outcomeOf({ status: 429 })).toBeNull();
    expect(outcomeOf({ status: 503 })).toBeNull();
    expect(outcomeOf({ status: 403 })).toBe("refused");
  });

  it("is tried again after a backoff until the last attempt, a refusal never", () => {
    const tried = [
      { index: 0, action: { kind: "comment" as const, body: "x" } },
      { index: 1, action: { kind: "add_labels" as const, labels: ["a"] } },
      { index: 2, action: { kind: "notify" as const, channelId: "c" } },
    ];
    const done = [
      { kind: "comment" as const, outcome: "unreached" as const },
      { kind: "add_labels" as const, outcome: "refused" as const },
      { kind: "notify" as const, outcome: "unreached" as const },
    ];
    const retry = retryOf("repo", 7, tried, done);
    expect(retry?.actions.map((a) => a.index)).toEqual([0]);
    const now = new Date(0);
    expect(resultOf(done, retry, 1, now)).toMatchObject({
      outcome: "failed",
      retryAt: new Date(60_000),
    });
    expect(resultOf(done, retry, MAX_ATTEMPTS, now)).toMatchObject({ retry: null, retryAt: null });
    expect(
      retryOf(
        "repo",
        7,
        tried,
        done.map((d) => ({ ...d, outcome: "done" as const })),
      ),
    ).toBeNull();
  });

  it("is claimed by one runner per attempt, and let go after the last", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    const retry = { reviewRepoId: "repo", number: 7, actions: [] };
    await d.insert("automationRuns", {
      ...rows.automationRuns("due"),
      retry,
      retryAt: new Date(1000),
    });
    await d.insert("automationRuns", {
      ...rows.automationRuns("spent"),
      eventKey: "review:spent",
      attempts: MAX_ATTEMPTS,
      retry,
      retryAt: new Date(1000),
    });
    const now = new Date(2000);
    const [a, b] = await Promise.all([
      claimAutomationRetry(db, now, 60_000, MAX_ATTEMPTS),
      claimAutomationRetry(db, now, 60_000, MAX_ATTEMPTS),
    ]);
    expect([a, b].filter(Boolean)).toEqual([expect.objectContaining({ id: "due", attempts: 2 })]);
    expect(await claimAutomationRetry(db, now, 60_000, MAX_ATTEMPTS)).toBeUndefined();
    const spent = await d.get("automationRuns", "spent");
    expect(spent).toMatchObject({ retry: null, retryAt: null, attempts: MAX_ATTEMPTS });
    await d.automations.finish("due", 1, {
      outcome: "done",
      actions: [],
      retry: null,
      retryAt: null,
    });
    expect((await d.get("automationRuns", "due"))?.outcome).toBe("running");
  });
});
