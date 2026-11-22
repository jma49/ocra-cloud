import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_CLAIM_MS } from "../src/db/finding-issues.js";
import { identities } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { parseFindings } from "../src/findings.js";
import { reviewRow } from "../src/reviews.js";
import {
  type FindingIssueAnswer,
  type FindingIssueDraftView,
  MAX_ISSUE_BODY_CHARS,
  MAX_ISSUE_TITLE_CHARS,
} from "../src/shared/index.js";
import { finding, upload } from "./finding-uploads.js";
import { db, resetDb, signIn } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// "Open an issue" from a finding: a draft from the finding's own text,
// neutralised, opened in the reviewed repository as the user, and only once
// per finding however often, or however fast, it is asked for.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const ISSUES = "https://api.github.com/repos/octo/api/issues";
const GITLAB_ISSUES = `${GITLAB}/api/v4/projects/${encodeURIComponent("group/sub/project")}/issues`;

type Sent = { method: string; url: string; body: unknown };
type Signed = Awaited<ReturnType<typeof signInWithGithub>>;

/** Answers the routes given, by method and URL, and records every write. */
function platform(routes: Record<string, () => Response | Promise<Response>>) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      if (req.method !== "GET") {
        sent.push({ method: req.method, url: req.url, body: await req.json() });
      }
      return route();
    },
  });
  return sent;
}

async function accountOf(subject: string) {
  const [identity] = await db.select().from(identities).where(eq(identities.subject, subject));
  return identity?.accountId ?? "";
}

/** A review of the account with one shared finding; the review's and the finding's ids. */
async function seed(
  accountId: string,
  pullRequest: { repository: string; number: number } | null,
  over: Record<string, unknown> = {},
) {
  const data = scoped(db, accountId);
  const { reviewersDropped: _, ...row } = reviewRow(
    reviewUploadSchema.parse({
      ...upload("run-1", []),
      ...(pullRequest ? { pullRequest: { ...pullRequest, headSha: HEAD } } : {}),
    }),
  );
  const [shared] = parseFindings([finding(over)]).rows;
  if (!shared) throw new Error("the finding was not read");
  const stored = await data.insertReview(row, [shared], { dailyUploads: 10, maxFindings: 10 });
  if (stored.outcome !== "stored") throw new Error(stored.outcome);
  const [f] = await data.findingsOf(stored.id);
  return { review: stored.id, id: f?.id ?? "", data };
}

const GITHUB_PULL = { repository: "https://github.com/octo/api", number: 7 };

const draftOf = (a: Signed, id: string) => a.send(`/api/findings/${id}/issue-draft`);

const open = (a: Signed, id: string, body: Record<string, unknown>) =>
  a.send(`/api/findings/${id}/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const edit = { title: "Critical: SQL built from input", body: "As drafted, edited." };
const created = (n: number) => () => Response.json({ number: n }, { status: 201 });

describe("an issue drafted from a finding on GitHub", () => {
  it("names the severity, the lines at the reviewed head and the pull request", async () => {
    platform({});
    const a = await signInWithGithub();
    const { id } = await seed(await accountOf("42"), GITHUB_PULL);
    const res = await draftOf(a, id);
    expect(res.status).toBe(200);
    const view = (await res.json()) as FindingIssueDraftView;
    expect(view).toMatchObject({ platform: "github", repo: "octo/api", issue: null });
    expect(view.title).toBe("Critical: SQL built from input");
    expect(view.body).toContain(
      `[octo/api\\#7](https://github.com/octo/api/pull/7) at \`aaaaaaaaaaaa\``,
    );
    expect(view.body).toContain(
      `[src/db.ts L10–12](https://github.com/octo/api/blob/${HEAD}/src/db.ts#L10-L12)`,
    );
    expect(view.body).toContain("The query concatenates user input.");
    expect(view.body).toContain("**Suggestion**\n\nUse a parameter.");
  });

  it("quotes hostile text as plain text: no HTML, no links of its own, no mentions", async () => {
    platform({});
    const a = await signInWithGithub();
    const { id } = await seed(await accountOf("42"), GITHUB_PULL, {
      title: "Ping @octo-team\nnow",
      category: "[x](javascript:alert(1))",
      body: "<img src=x onerror=alert(1)>\n\n# Heading [link](http://evil.example) @admin\n\n\n\nend",
      file: "src/../../etc/passwd",
    });
    const view = (await (await draftOf(a, id)).json()) as FindingIssueDraftView;
    expect(view.title).toBe("Critical: Ping @​octo-team now");
    expect(view.body).not.toMatch(/<|\]\(javascript|\]\(http:/);
    expect(view.body).not.toMatch(/@\w/);
    expect(view.body).toContain("&lt;img src=x onerror=alert\\(1\\)&gt;");
    expect(view.body).toContain("\\# Heading \\[link\\]\\(http\\:");
    expect(view.body).not.toContain("\n\n\n");
    // A path that leaves the repository is named, never linked.
    expect(view.body).toContain("in src/../../etc/passwd L10–12.");
  });

  it("mentions no one from the finding's file path", async () => {
    platform({});
    const a = await signInWithGithub();
    const { id } = await seed(await accountOf("42"), GITHUB_PULL, { file: "src/@admin/db.ts" });
    const view = (await (await draftOf(a, id)).json()) as FindingIssueDraftView;
    expect(view.body).toContain("src/\\@​admin/db.ts L10–12");
    expect(view.body).not.toMatch(/@\w/);
  });

  it("fits within what the platform takes however much the escapes grow the finding's text", async () => {
    platform({});
    const a = await signInWithGithub();
    const { id } = await seed(await accountOf("42"), GITHUB_PULL, {
      title: "@&".repeat(2048),
      body: "&@".repeat(2048),
      suggestion: "<@".repeat(2048),
      category: "&".repeat(64),
    });
    const view = (await (await draftOf(a, id)).json()) as FindingIssueDraftView;
    expect([...view.title].length).toBeLessThanOrEqual(MAX_ISSUE_TITLE_CHARS);
    expect(view.body.length).toBeLessThanOrEqual(MAX_ISSUE_BODY_CHARS);
    expect(view.body).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  it("answers not found for a finding of another account, missing, or of no pull request", async () => {
    platform({});
    const a = await signInWithGithub();
    const other = await signIn(9, "other");
    const theirs = await seed(other.account.id, GITHUB_PULL);
    expect((await draftOf(a, theirs.id)).status).toBe(404);
    expect((await open(a, theirs.id, edit)).status).toBe(404);
    expect((await draftOf(a, "missing")).status).toBe(404);
    await resetDb();
    platform({});
    const b = await signInWithGithub();
    const local = await seed(await accountOf("42"), null);
    expect((await draftOf(b, local.id)).status).toBe(404);
    expect((await open(b, local.id, edit)).status).toBe(404);
  });
});

describe("opening the issue on GitHub", () => {
  it("opens the edited issue as the user once, and the review lists it on the finding", async () => {
    const sent = platform({ [`POST ${ISSUES}`]: created(41) });
    const a = await signInWithGithub();
    const { id, review } = await seed(await accountOf("42"), GITHUB_PULL);
    const res = await open(a, id, edit);
    expect(res.status).toBe(200);
    const issue = { number: 41, url: "https://github.com/octo/api/issues/41" };
    expect(await res.json()).toEqual({ outcome: "done", issue, created: true });
    expect(sent).toEqual([{ method: "POST", url: ISSUES, body: edit }]);

    const again = (await (
      await open(a, id, { ...edit, title: "Another" })
    ).json()) as FindingIssueAnswer;
    expect(again).toEqual({ outcome: "done", issue, created: false });
    expect(sent).toHaveLength(1);

    const draft = (await (await draftOf(a, id)).json()) as FindingIssueDraftView;
    expect(draft.issue).toEqual(issue);
    const detail = (await (await a.send(`/api/reviews/${review}`)).json()) as {
      findings: { id: string; issue: unknown }[];
    };
    expect(detail.findings).toEqual([expect.objectContaining({ id, issue })]);
  });

  it("opens one issue for two clicks at once", async () => {
    let answer: (r: Response) => void = () => {};
    const sent = platform({
      [`POST ${ISSUES}`]: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    const a = await signInWithGithub();
    const { id } = await seed(await accountOf("42"), GITHUB_PULL);
    const first = open(a, id, edit);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const second = (await (await open(a, id, edit)).json()) as FindingIssueAnswer;
    expect(second).toEqual({ outcome: "pending" });
    answer(Response.json({ number: 3 }, { status: 201 }));
    expect(await (await first).json()).toMatchObject({ outcome: "done", created: true });
    expect(sent).toHaveLength(1);
  });

  it("takes over a claim whose creation never finished", async () => {
    const sent = platform({ [`POST ${ISSUES}`]: created(5) });
    const a = await signInWithGithub();
    const { id, review, data } = await seed(await accountOf("42"), GITHUB_PULL);
    await data.insert("findingIssues", {
      findingId: id,
      reviewId: review,
      claimedAt: new Date(Date.now() - ISSUE_CLAIM_MS - 1000),
    });
    expect(await (await open(a, id, edit)).json()).toMatchObject({
      outcome: "done",
      created: true,
    });
    expect(sent).toHaveLength(1);
    expect(await data.list("findingIssues")).toHaveLength(1);
  });

  it("answers a refusal, keeps nothing, and opens it on the next click", async () => {
    let status = 410;
    const sent = platform({
      [`POST ${ISSUES}`]: () =>
        status === 201 ? Response.json({ number: 8 }, { status }) : new Response("{}", { status }),
    });
    const a = await signInWithGithub();
    const { id, data } = await seed(await accountOf("42"), GITHUB_PULL);
    expect(await (await open(a, id, edit)).json()).toEqual({ outcome: "refused" });
    expect(await data.list("findingIssues")).toEqual([]);
    status = 500;
    const unreached = await open(a, id, edit);
    expect(unreached.status).toBe(502);
    expect(await data.list("findingIssues")).toEqual([]);
    status = 201;
    expect(await (await open(a, id, edit)).json()).toMatchObject({
      outcome: "done",
      created: true,
    });
    expect(sent).toHaveLength(3);
  });

  it("refuses a title or body that does not fit, without calling the platform", async () => {
    const sent = platform({ [`POST ${ISSUES}`]: created(1) });
    const a = await signInWithGithub();
    const { id } = await seed(await accountOf("42"), GITHUB_PULL);
    for (const body of [
      { ...edit, title: "  " },
      { ...edit, title: "two\nlines" },
      { ...edit, title: "x".repeat(MAX_ISSUE_TITLE_CHARS + 1) },
      { ...edit, body: "x".repeat(MAX_ISSUE_BODY_CHARS + 1) },
      { title: edit.title },
    ]) {
      expect((await open(a, id, body)).status).toBe(400);
    }
    expect(sent).toEqual([]);
  });
});

describe("opening the issue on GitLab", () => {
  it("opens it in the reviewed project, linking the lines at the reviewed head", async () => {
    const sent = platform({
      [`POST ${GITLAB_ISSUES}`]: () => Response.json({ iid: 5, id: 900 }, { status: 201 }),
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const { id } = await seed(await accountOf("42"), {
      repository: "https://gitlab.example.com/group/sub/project",
      number: 3,
    });
    const view = (await (await draftOf(a, id)).json()) as FindingIssueDraftView;
    expect(view).toMatchObject({ platform: "gitlab", repo: "group/sub/project" });
    expect(view.body).toContain(`(${GITLAB}/group/sub/project/-/merge_requests/3)`);
    expect(view.body).toContain(`(${GITLAB}/group/sub/project/-/blob/${HEAD}/src/db.ts#L10-12)`);
    const res = (await (await open(a, id, edit)).json()) as FindingIssueAnswer;
    expect(res).toEqual({
      outcome: "done",
      issue: { number: 5, url: `${GITLAB}/group/sub/project/-/issues/5` },
      created: true,
    });
    expect(sent).toEqual([
      {
        method: "POST",
        url: GITLAB_ISSUES,
        body: { title: edit.title, description: edit.body },
      },
    ]);
  });

  it("mentions no one from the finding's file path there either", async () => {
    platform({});
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const { id } = await seed(
      await accountOf("42"),
      { repository: "https://gitlab.example.com/group/sub/project", number: 3 },
      { file: "src/@admin/db.ts" },
    );
    const view = (await (await draftOf(a, id)).json()) as FindingIssueDraftView;
    expect(view.platform).toBe("gitlab");
    expect(view.body).not.toMatch(/@\w/);
  });
});
