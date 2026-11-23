import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { forgetPlatformAnswers } from "../src/platforms/answer-cache.js";
import { db, resetDb, signIn } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";
import {
  BASE,
  byKind,
  type GithubPull,
  githubPull,
  HEAD,
  NOT_PROTECTED,
  OLD,
  PLAN,
  PROTECTION,
  REFUSED,
  RULESETS_CALL,
  readiness,
  run,
} from "./readiness-fakes.js";

// A pull request's merge readiness, read as the user in one GraphQL query on
// GitHub and in bounded calls on GitLab: a requirement the token cannot read
// is unknown, and the pre-merge checks are only the account's own.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const accountId = async () => (await db.select().from(schema.accounts))[0]?.id ?? "";

async function enroll(account: string, id = `repo-${account}`) {
  await scoped(db, account).insert("reviewRepos", {
    id,
    platform: "github",
    host: "github.com",
    platformRepoId: `p-${id}`,
    fullName: "Octo/API",
  });
  return id;
}

describe("merge readiness on GitHub", () => {
  it("lists each requirement from one query, owners partly approved and a stale approval left out", async () => {
    const calls = githubPull({
      files: ["src/app.ts", "src/db/query.ts", "README.md"],
      reviews: [
        { login: "lead", oid: HEAD },
        { login: "dba", oid: OLD },
      ],
      threads: [true, false],
      mergeable: "CONFLICTING",
      contexts: [
        run("ci", "COMPLETED", "SUCCESS", true),
        run("lint", "IN_PROGRESS", null, true),
        run("preview", "COMPLETED", "FAILURE", false),
      ],
    });
    const a = await signInWithGithub();
    const view = await readiness(a.send, "platform=github&repo=octo/api&number=7");
    expect(calls).toEqual(["POST https://api.github.com/graphql", RULESETS_CALL]);
    expect(view).toMatchObject({ state: "open", head: HEAD, ready: "unmet" });
    expect(byKind(view)).toEqual({
      draft: ["met", "Ready for review"],
      conflicts: ["unmet", "Conflicts with the base branch"],
      approvals: [
        "unmet",
        "1 of 2 required approvals; 1 approval of an earlier head no longer count",
      ],
      code_owners: ["unmet", "1 of 3 owner groups approved; waiting on dba"],
      required_checks: ["pending", "Waiting for lint"],
      threads: ["unmet", "1 unresolved thread"],
      premerge_checks: ["met", "No pre-merge checks set up"],
    });
    expect(view.codeOwners).toEqual([
      { owners: ["lead"], files: 1, state: "met", approvedBy: ["lead"], required: true },
      { owners: ["dba"], files: 1, state: "unmet", approvedBy: [], required: true },
      {
        owners: ["docs@example.com"],
        files: 1,
        state: "unknown",
        approvedBy: [],
        required: true,
      },
    ]);
    expect(view.staleApprovals).toEqual(["dba"]);
  });

  it("says unknown where the token cannot read the branch rule, and counts a team's approval", async () => {
    githubPull({
      ruleRefused: true,
      decision: null,
      files: ["src/app.ts", "web/page.tsx"],
      reviews: [
        { login: "lead", oid: OLD },
        { login: "designer", oid: HEAD, teams: ["octo/web"] },
      ],
      contexts: [run("ci", "COMPLETED", "SUCCESS", false)],
    });
    const a = await signInWithGithub();
    const items = byKind(await readiness(a.send, "platform=github&repo=octo/api&number=7"));
    expect(items.approvals).toEqual([
      "unknown",
      "2 approvals; branch rule not readable; 1 approval of an earlier head still count",
    ]);
    expect(items.code_owners).toEqual(["met", "2 of 2 owner groups approved"]);
    expect(items.required_checks).toEqual([
      "unknown",
      "None of the head's 1 check is marked required; branch rule not readable",
    ]);
  });

  it("leaves a group whose owner has not approved unknown when the rule is unreadable", async () => {
    githubPull({ ruleRefused: true, decision: null, files: ["src/db/query.ts"], reviews: [] });
    const a = await signInWithGithub();
    const view = await readiness(a.send, "platform=github&repo=octo/api&number=7");
    expect(byKind(view).code_owners).toEqual([
      "unknown",
      "0 of 1 owner group approved; whether the rest must approve is not known (branch rule not readable)",
    ]);
    expect(view.codeOwners[0]).toMatchObject({ owners: ["dba"], state: "unmet", required: null });
  });

  it("judges only this account's pre-merge checks, from the same query", async () => {
    const calls = githubPull({
      rule: null,
      protection: NOT_PROTECTED,
      decision: null,
      title: "cap refunds",
      files: ["docs/x.txt"],
    });
    const a = await signInWithGithub();
    const me = await accountId();
    const other = await signIn(9, "eve");
    const theirs = await enroll(other.account.id);
    await scoped(db, other.account.id).mergeChecks.add(
      theirs,
      { kind: "title", mode: "block", settings: { prefixes: ["feat"] } },
      20,
    );
    const first = byKind(await readiness(a.send, "platform=github&repo=octo/api&number=7"));
    expect(first.premerge_checks).toEqual(["met", "No pre-merge checks set up"]);
    expect(first.approvals).toEqual(["met", "No approval is required (0 given)"]);
    expect(first.code_owners).toEqual(["met", "No code owners for the changed files"]);
    expect(first.required_checks).toEqual(["met", "No check is required"]);

    const mine = await enroll(me);
    await scoped(db, me).mergeChecks.add(
      mine,
      { kind: "title", mode: "block", settings: { prefixes: ["feat"] } },
      20,
    );
    const second = await readiness(a.send, "platform=github&repo=octo/api&number=7");
    expect(byKind(second).premerge_checks).toEqual(["unmet", "1 blocking check failed"]);
    expect(second.ready).toBe("unmet");
    const graphql = "POST https://api.github.com/graphql";
    // The branch rule's refusal is remembered: the second reading does not ask it again.
    expect(calls).toEqual([graphql, PROTECTION, RULESETS_CALL, graphql, RULESETS_CALL]);
  });

  it("never takes a rule GraphQL leaves out for no rule: the REST rule says which it is", async () => {
    const view = async (protection: NonNullable<GithubPull["protection"]>) => {
      vi.restoreAllMocks();
      // Each answer stands for another repository: none remembers the last one's refusal.
      forgetPlatformAnswers();
      githubPull({ rule: null, protection, decision: null, contexts: [] });
      const a = await signInWithGithub();
      return byKind(await readiness(a.send, "platform=github&repo=octo/api&number=7"));
    };
    const refused = await view(REFUSED);
    expect(refused.approvals).toEqual(["unknown", "0 approvals; branch rule not readable"]);
    expect(refused.required_checks).toEqual([
      "unknown",
      "No check reported; branch rule not readable",
    ]);
    const plan = await view(PLAN);
    expect(plan.approvals).toEqual([
      "unknown",
      "0 approvals; branch rules not available on this repository's plan",
    ]);
    const none = await view(NOT_PROTECTED);
    expect(none.approvals).toEqual(["met", "No approval is required (0 given)"]);
    expect(none.required_checks).toEqual(["met", "No check is required"]);
    const read = await view({
      status: 200,
      body: {
        required_pull_request_reviews: { required_approving_review_count: 1 },
        required_status_checks: { contexts: ["ci"], checks: [{ context: "ci" }] },
      },
    });
    expect(read.approvals).toEqual(["unmet", "0 of 1 required approvals"]);
    expect(read.required_checks).toEqual(["pending", "Waiting for ci"]);
  });

  it("is unmet on the platform's word that a review is required, though the count is unread", async () => {
    githubPull({ ruleRefused: true, decision: "REVIEW_REQUIRED", reviews: [] });
    const a = await signInWithGithub();
    const items = byKind(await readiness(a.send, "platform=github&repo=octo/api&number=7"));
    expect(items.approvals).toEqual([
      "unmet",
      "Review required; 0 approvals; branch rule not readable",
    ]);
  });

  it("offers a branch update when GitHub holds a branch behind its base, not one that conflicts", async () => {
    const offered = async (pull: GithubPull) => {
      vi.restoreAllMocks();
      githubPull(pull);
      const a = await signInWithGithub();
      return (await readiness(a.send, "platform=github&repo=octo/api&number=7")).canUpdateBranch;
    };
    expect(await offered({ mergeStateStatus: "BEHIND" })).toBe(true);
    expect(await offered({ mergeStateStatus: "BLOCKED" })).toBe(false);
    expect(await offered({ mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" })).toBe(false);
    expect(await offered({ mergeStateStatus: "BEHIND", state: "MERGED" })).toBe(false);
  });

  it("lists nothing for a merged pull request and refuses a bad reference", async () => {
    githubPull({ state: "MERGED" });
    const a = await signInWithGithub();
    const view = await readiness(a.send, "platform=github&repo=octo/api&number=7");
    expect(view).toMatchObject({ state: "merged", ready: null, items: [] });
    expect((await a.send("/api/pulls/readiness?platform=github&repo=../x&number=7")).status).toBe(
      404,
    );
  });
});

describe("merge readiness on GitLab", () => {
  const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}/merge_requests/7`;
  const PROJECT = `${GITLAB}/api/v4/projects/9`;

  function gitlabMr(over: { premium: boolean; status: string; project: Record<string, unknown> }) {
    const calls: string[] = [];
    githubFake({
      extra: (req) => {
        const url = req.url;
        if (!url.startsWith(`${GITLAB}/api/v4/`) || url === `${GITLAB}/api/v4/user`) {
          return undefined;
        }
        if (url.startsWith(`${GITLAB}/api/v4/projects?membership`)) return undefined;
        calls.push(url);
        if (url === MR) {
          return Response.json({
            project_id: 9,
            state: "opened",
            draft: over.premium,
            has_conflicts: false,
            detailed_merge_status: over.status,
            sha: HEAD,
            title: "Cap",
            description: null,
            changes_count: "2",
            diff_refs: { base_sha: BASE, head_sha: HEAD, start_sha: BASE },
            head_pipeline: { status: "running" },
          });
        }
        if (url === `${MR}/approvals`) {
          return over.premium
            ? Response.json({
                approvals_required: 2,
                approvals_left: 1,
                approved_by: [{ user: { username: "alice" } }],
              })
            : Response.json({ approved_by: [] });
        }
        if (url === `${MR}/approval_state`) {
          if (!over.premium) return new Response(null, { status: 403 });
          return Response.json({
            rules: [
              { rule_type: "regular", name: "All", approved: false, approvals_required: 2 },
              {
                rule_type: "code_owner",
                name: "/api/",
                section: "Backend",
                approved: true,
                approvals_required: 1,
                eligible_approvers: [{ username: "alice" }],
                approved_by: [{ username: "alice" }],
              },
              {
                rule_type: "code_owner",
                name: "*.go",
                section: "codeowners",
                approved: false,
                approvals_required: 1,
                eligible_approvers: [{ username: "gopher" }],
              },
            ],
          });
        }
        if (url === `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}`) {
          return Response.json(over.project);
        }
        if (url === `${MR}/discussions?per_page=100&page=1`) {
          return Response.json([
            { notes: [{ resolvable: true, resolved: false }] },
            { notes: [{ resolvable: true, resolved: true }] },
            { notes: [{ resolvable: false }] },
          ]);
        }
        if (url === `${MR}/diffs?per_page=100&page=1`) {
          return Response.json([
            { new_path: "api/x.go", diff: "@@ -1 +1 @@\n-a\n+b\n" },
            { new_path: "README.md", diff: "" },
          ]);
        }
        if (url.startsWith(`${PROJECT}/repository/files/`)) {
          const path = decodeURIComponent(url.slice(`${PROJECT}/repository/files/`.length));
          expect(path.endsWith(`?ref=${BASE}`)).toBe(true);
          if (!path.startsWith("CODEOWNERS")) return new Response(null, { status: 404 });
          const text = "[Backend]\n/api/ @gopher\n[Docs]\n*.md @writer";
          return Response.json({
            blob_id: "e".repeat(40),
            last_commit_id: BASE,
            size: text.length,
            encoding: "base64",
            content: btoa(text),
          });
        }
        return undefined;
      },
    });
    return calls;
  }

  it("takes GitLab's own code owner rules and approvals where it gives them", async () => {
    const calls = gitlabMr({
      premium: true,
      status: "not_approved",
      project: { only_allow_merge_if_pipeline_succeeds: true },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const view = await readiness(a.send, "platform=gitlab&repo=Group/Sub/Project&number=7");
    expect(byKind(view)).toEqual({
      draft: ["unmet", "Still a draft"],
      conflicts: ["met", "No conflicts with the base branch"],
      approvals: ["unmet", "1 of 2 required approvals"],
      code_owners: ["unmet", "1 of 2 owner groups approved; waiting on *.go or gopher"],
      required_checks: ["pending", "Waiting for pipeline"],
      threads: ["unmet", "1 unresolved thread"],
      premerge_checks: ["met", "No pre-merge checks set up"],
    });
    expect(view.codeOwners).toEqual([
      {
        owners: ["[Backend] /api/", "alice"],
        files: null,
        state: "met",
        approvedBy: ["alice"],
        required: true,
      },
      { owners: ["*.go", "gopher"], files: null, state: "unmet", approvedBy: [], required: true },
    ]);
    expect(calls.filter((u) => u.includes("/repository/files/"))).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it("offers a branch update where GitLab says a rebase is needed", async () => {
    gitlabMr({ premium: false, status: "need_rebase", project: {} });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const view = await readiness(a.send, "platform=gitlab&repo=Group/Sub/Project&number=7");
    expect(view.canUpdateBranch).toBe(true);
  });

  it("matches CODEOWNERS at the base where the rules are refused, and never guesses", async () => {
    gitlabMr({ premium: false, status: "mergeable", project: {} });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const view = await readiness(a.send, "platform=gitlab&repo=Group/Sub/Project&number=7");
    const items = byKind(view);
    expect(items.approvals).toEqual(["unknown", "0 approvals; required count not readable"]);
    expect(items.code_owners).toEqual([
      "unknown",
      "0 of 2 owner groups approved; whether the rest must approve is not readable",
    ]);
    expect(view.codeOwners.map((g) => [g.owners, g.files, g.state])).toEqual([
      [["gopher"], 1, "unknown"],
      [["writer"], 1, "unknown"],
    ]);
    expect(items.required_checks).toEqual(["met", "The platform reports nothing blocking"]);
  });
});
