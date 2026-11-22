import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { type CheckConfig, evaluateChecks, globMatches } from "../src/merge-checks/evaluate.js";
import { judgeLinkedTasks } from "../src/merge-checks/linked-tasks.js";
import { gitlabMergeStatus } from "../src/platforms/gitlab-merge-status.js";
import type { PullFacts } from "../src/platforms/merge-status.js";
import type { LinkedTaskView, MergeCheckView, PullChecksView } from "../src/shared/index.js";
import { db, resetDb, signIn } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// Pre-merge checks: judged from the pull request and its head's stored
// review, configured per enrolled repository, and answered for the page.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const facts = (over: Partial<PullFacts> = {}): PullFacts => ({
  title: "feat(api): cap refunds",
  description: "## Why\nRefunds ran over.\n\n## Testing\nUnit tests.",
  head: HEAD,
  files: 3,
  lines: 40,
  exact: true,
  ...over,
});
let n = 0;
const check = (kind: CheckConfig["kind"], settings: unknown, mode: CheckConfig["mode"] = "block") =>
  ({ id: `c${n++}`, kind, mode, settings }) satisfies CheckConfig;

describe("judging a pull request", () => {
  it("fails on a blocking check, is neutral on a warning, and skips what is off", () => {
    const title = check("title", { prefixes: ["fix", "docs"] });
    expect(evaluateChecks([title], facts(), null)).toMatchObject({
      conclusion: "failure",
      results: [{ kind: "title", mode: "block", outcome: "failed" }],
    });
    expect(evaluateChecks([{ ...title, mode: "warn" }], facts(), null).conclusion).toBe("neutral");
    expect(evaluateChecks([{ ...title, mode: "off" }], facts(), null)).toEqual({
      head: HEAD,
      conclusion: "success",
      results: [],
    });
  });

  it("matches a title by prefix or glob, never as a regular expression", () => {
    expect(globMatches("feat(*): *", "feat(api): cap refunds")).toBe(true);
    expect(globMatches("feat?api", "feat(api")).toBe(true);
    expect(globMatches("feat?api", "feat((api")).toBe(false);
    expect(globMatches("a.b", "axb")).toBe(false);
    expect(globMatches("*x", "abc")).toBe(false);
    // A pattern that backtracks exponentially as a regular expression answers at once.
    const started = Date.now();
    expect(globMatches("*a*a*a*a*a*a*a*a*a*b", "a".repeat(5000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    const report = evaluateChecks([check("title", { glob: "feat(*): *" })], facts(), null);
    expect(report.results[0]?.outcome).toBe("passed");
  });

  it("wants a description with its sections, hints left as comments not counted", () => {
    const description = check("description", { headings: ["Why", "testing"] });
    expect(evaluateChecks([description], facts(), null).results[0]?.outcome).toBe("passed");
    const template = facts({ description: "<!-- Say why -->\n  " });
    expect(evaluateChecks([description], template, null).results[0]).toMatchObject({
      outcome: "failed",
      detail: "the description is empty",
    });
    const partial = facts({ description: "## Why\nBecause.\n#Testing" });
    expect(evaluateChecks([description], partial, null).results[0]?.detail).toBe(
      'the description has no "testing" section',
    );
  });

  it("limits the size, and says when it could not count everything", () => {
    const size = check("size", { maxFiles: 5, maxLines: 100 });
    expect(evaluateChecks([size], facts(), null).results[0]?.outcome).toBe("passed");
    expect(evaluateChecks([size], facts({ lines: 101 }), null).results[0]).toMatchObject({
      outcome: "failed",
      detail: "101 lines changed, more than 100",
    });
    expect(evaluateChecks([size], facts({ exact: false }), null).results[0]?.outcome).toBe(
      "not_evaluated",
    );
  });

  it("blocks on the head's unresolved critical findings, once it has a review", () => {
    const critical = check("critical_findings", {});
    expect(evaluateChecks([critical], facts(), null)).toMatchObject({
      conclusion: "success",
      results: [{ outcome: "not_evaluated" }],
    });
    expect(evaluateChecks([critical], facts(), { unresolvedCritical: 2 })).toMatchObject({
      conclusion: "failure",
      results: [{ outcome: "failed", detail: "2 unresolved critical findings on this head" }],
    });
    expect(evaluateChecks([critical], facts(), { unresolvedCritical: 0 }).conclusion).toBe(
      "success",
    );
  });

  it("reports linked issues and plain-language checks as not evaluated yet", () => {
    const report = evaluateChecks(
      [check("linked_issue", { open: true }), check("instruction", { text: "No new globals" })],
      facts(),
      null,
    );
    expect(report.conclusion).toBe("success");
    expect(
      report.results.map((r) => [r.outcome, r.detail.startsWith("not evaluated yet")]),
    ).toEqual([
      ["not_evaluated", true],
      ["not_evaluated", true],
    ]);
  });
});

async function enrolled(accountId: string, id = `repo-${accountId}`) {
  await scoped(db, accountId).insert("reviewRepos", {
    id,
    platform: "github",
    host: "github.com",
    platformRepoId: `p-${id}`,
    fullName: "Octo/API",
  });
  return id;
}

describe("the stored checks and results", () => {
  it("adds checks under the repository's cap, only to the account's own repository", async () => {
    const a = await signIn(1, "a");
    const b = await signIn(2, "b");
    const repo = await enrolled(a.account.id);
    const mine = scoped(db, a.account.id).mergeChecks;
    const check = { kind: "size" as const, mode: "warn" as const, settings: { maxFiles: 1 } };
    expect(await mine.add(repo, check, 2)).toBeTypeOf("string");
    expect(await mine.add(repo, check, 2)).toBeTypeOf("string");
    expect(await mine.add(repo, check, 2)).toBeUndefined();
    expect(await scoped(db, b.account.id).mergeChecks.add(repo, check, 20)).toBeUndefined();
    expect(await scoped(db, b.account.id).count("mergeChecks")).toBe(0);
  });

  it("lets one caller post a head's result, again only when it changes", async () => {
    const a = await signIn(1, "a");
    const repo = await enrolled(a.account.id);
    const runs = scoped(db, a.account.id).mergeChecks;
    const run = { reviewRepoId: repo, number: 7, head: HEAD, conclusion: "success" as const };
    const id = await runs.record({ ...run, results: [], digest: "one" }, new Date());
    expect(id).toBeTypeOf("string");
    const claims = await Promise.all([
      runs.claimPost(`${id}`, "one"),
      runs.claimPost(`${id}`, "one"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await runs.record({ ...run, results: [], digest: "one" }, new Date())).toBe(id);
    expect(await runs.claimPost(`${id}`, "one")).toBe(false);
    await runs.record({ ...run, conclusion: "failure", results: [], digest: "two" }, new Date());
    expect(await runs.claimPost(`${id}`, "one")).toBe(false);
    expect(await runs.claimPost(`${id}`, "two")).toBe(true);
    await runs.releasePost(`${id}`, "two");
    expect(await runs.claimPost(`${id}`, "two")).toBe(true);
  });
});

const PULL = "https://api.github.com/repos/Octo/API/pulls/7";

describe("the checks API", () => {
  it("configures a repository's checks and answers a pull request's result", async () => {
    githubFake({
      extra: (req) =>
        req.url === PULL
          ? Response.json({
              title: "Cap refunds",
              body: "",
              head: { sha: HEAD },
              changed_files: 2,
              additions: 5,
              deletions: 1,
            })
          : undefined,
    });
    const me = await signInWithGithub();
    const [account] = await db.select().from(schema.accounts);
    const repo = await enrolled(account?.id ?? "");
    const add = (json: unknown) =>
      me.send(`/api/merge-checks/repos/${repo}/checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(json),
      });
    const title = await add({ kind: "title", mode: "block", settings: { prefixes: ["feat"] } });
    expect(title.status).toBe(200);
    const { check } = (await title.json()) as { check: MergeCheckView };
    expect(check).toMatchObject({ kind: "title", settings: { prefixes: ["feat"] } });
    expect((await add({ kind: "description", mode: "warn" })).status).toBe(200);
    expect(
      (await add({ kind: "title", mode: "block", settings: { pattern: "(a+)+$" } })).status,
    ).toBe(400);
    expect((await add({ kind: "size", mode: "block", settings: {} })).status).toBe(400);

    const page = await me.send("/api/pulls/checks?platform=github&repo=octo/api&number=7");
    expect(page.status).toBe(200);
    expect((await page.json()) as PullChecksView).toEqual({
      report: {
        head: HEAD,
        conclusion: "failure",
        results: [
          expect.objectContaining({ kind: "title", outcome: "failed" }),
          expect.objectContaining({ kind: "description", mode: "warn", outcome: "failed" }),
        ],
      },
      postedAt: null,
    });

    const changed = await me.send(`/api/merge-checks/repos/${repo}/checks/${check.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "warn", settings: { glob: "Cap *" } }),
    });
    expect(await changed.json()).toMatchObject({
      check: { mode: "warn", settings: { glob: "Cap *" } },
    });
    const again = (await (
      await me.send("/api/pulls/checks?platform=github&repo=Octo/API&number=7")
    ).json()) as PullChecksView;
    expect(again.report?.conclusion).toBe("neutral");

    const removed = await me.send(`/api/merge-checks/repos/${repo}/checks/${check.id}`, {
      method: "DELETE",
    });
    expect(await removed.json()).toEqual({ removed: true });
    const listed = await me.send(`/api/merge-checks/repos/${repo}/checks`);
    expect(((await listed.json()) as { checks: unknown[] }).checks).toHaveLength(1);
  });

  it("keeps another account's repository and checks out of reach", async () => {
    githubFake();
    const me = await signInWithGithub();
    const other = await signIn(9, "other");
    const repo = await enrolled(other.account.id);
    await scoped(db, other.account.id).mergeChecks.add(
      repo,
      { kind: "size", mode: "block", settings: { maxFiles: 1 } },
      20,
    );
    expect((await me.send(`/api/merge-checks/repos/${repo}/checks`)).status).toBe(404);
    const add = await me.send(`/api/merge-checks/repos/${repo}/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "critical_findings", mode: "block" }),
    });
    expect(add.status).toBe(404);
    const page = await me.send("/api/pulls/checks?platform=github&repo=Octo/API&number=7");
    expect(await page.json()).toEqual({ report: null, postedAt: null });
    const rows = await db
      .select()
      .from(schema.mergeChecks)
      .where(eq(schema.mergeChecks.reviewRepoId, repo));
    expect(rows).toHaveLength(1);
  });
});

describe("GitLab's side of the checks", () => {
  const LAB = "https://gitlab.example.com";
  const MR = `${LAB}/api/v4/projects/${encodeURIComponent("group/api")}/merge_requests/3`;

  it("counts a merge request's diffs and posts one commit status", async () => {
    const posts: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url === MR) {
        return Response.json({ title: "Cap", description: null, sha: HEAD, changes_count: "2" });
      }
      if (req.url === `${MR}/diffs?per_page=100&page=1`) {
        return Response.json([{ diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" }, { diff: "" }]);
      }
      if (req.method === "POST") {
        posts.push({ url: req.url, body: await req.json() });
        return Response.json({ id: 55 }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    });
    const lab = gitlabMergeStatus(LAB);
    expect(await lab.facts("glpat", "group/api", 3)).toEqual({
      title: "Cap",
      description: "",
      head: HEAD,
      files: 2,
      lines: 3,
      exact: true,
    });
    const status = { conclusion: "failure" as const, title: "1 blocking check failed" };
    const id = await lab.publish(
      "glpat",
      "group/api",
      HEAD,
      { ...status, summary: "-", detailsUrl: "https://ocra.test/pull" },
      null,
    );
    expect(id).toBe("55");
    expect(posts).toEqual([
      {
        url: `${LAB}/api/v4/projects/group%2Fapi/statuses/${HEAD}`,
        body: {
          state: "failed",
          name: "ocra / pre-merge",
          description: "1 blocking check failed",
          target_url: "https://ocra.test/pull",
        },
      },
    ]);
  });
});

describe("the linked issue check", () => {
  const task = (over: Partial<NonNullable<LinkedTaskView>> = {}): LinkedTaskView => ({
    tracker: "github",
    key: "#12",
    url: "https://github.com/octo/api/issues/12",
    state: "open",
    ...over,
  });

  it("waits for a review that looked the tasks up, and fails on none found", () => {
    expect(judgeLinkedTasks({}, undefined).outcome).toBe("not_evaluated");
    expect(judgeLinkedTasks({}, [])).toEqual({ outcome: "failed", detail: "no linked issue" });
    expect(judgeLinkedTasks({}, [null]).outcome).toBe("not_evaluated");
    expect(judgeLinkedTasks({}, [null, task()])).toEqual({
      outcome: "passed",
      detail: "links #12",
    });
    const elsewhere = [
      task({ tracker: "jira", key: "PAY-7", url: "https://acme.atlassian.net/browse/PAY-7" }),
      task({ tracker: "tapd", key: "1001234", state: "closed" }),
    ];
    expect(judgeLinkedTasks({ open: true }, elsewhere)).toEqual({
      outcome: "passed",
      detail: "links PAY-7",
    });
  });

  it("wants an open one when asked, an unknown state not counting", () => {
    const closed = [task({ state: "closed" }), task({ key: "#13", state: null })];
    expect(judgeLinkedTasks({}, closed).outcome).toBe("passed");
    expect(judgeLinkedTasks({ open: true }, closed)).toEqual({
      outcome: "failed",
      detail: "no linked issue is open",
    });
    expect(judgeLinkedTasks({ open: true }, [...closed, task({ key: "#14" })]).detail).toBe(
      "links #14",
    );
  });

  it("wants the label on an open one, and waits when labels were not shared", () => {
    expect(judgeLinkedTasks({ label: "Ready" }, [task()]).outcome).toBe("not_evaluated");
    expect(
      judgeLinkedTasks({ open: true, label: "ready" }, [
        task({ labels: ["ready"], state: "closed" }),
        task({ key: "#13", labels: ["bug"] }),
      ]),
    ).toEqual({ outcome: "failed", detail: 'no linked issue carries the label "ready"' });
    expect(judgeLinkedTasks({ label: "ready" }, [task({ labels: ["Ready"] })]).outcome).toBe(
      "passed",
    );
  });

  it("fails the pull request at its mode from the head's review", () => {
    const linked = check("linked_issue", { open: true }, "warn");
    const none = { unresolvedCritical: 0, linkedTasks: [] };
    expect(evaluateChecks([linked], facts(), none).conclusion).toBe("neutral");
    expect(evaluateChecks([{ ...linked, mode: "block" }], facts(), none).conclusion).toBe(
      "failure",
    );
  });
});
