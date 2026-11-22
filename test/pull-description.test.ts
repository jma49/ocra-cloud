import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accounts, identities } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { inline, withSection } from "../src/description-draft.js";
import { parseFindings } from "../src/findings.js";
import { reviewRow } from "../src/reviews.js";
import {
  DESCRIPTION_END,
  DESCRIPTION_START,
  MAX_DESCRIPTION_CHARS,
  type PullDescriptionDraftView,
} from "../src/shared/index.js";
import { parseWalkthrough } from "../src/walkthrough.js";
import { finding, upload } from "./finding-uploads.js";
import { db, resetDb, signIn } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// "Write the PR description": a draft from ocra's stored review of the pull
// request, its own section between markers so the user's text is kept, and
// the user's edit saved to the platform as them, only on the head drafted on.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const PULL = "https://api.github.com/repos/octo/api/pulls/7";
const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}/merge_requests/3`;

type Sent = { method: string; url: string; body: unknown };
type Signed = Awaited<ReturnType<typeof signInWithGithub>>;

function platform(routes: Record<string, () => Response>) {
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

const githubPull =
  (body: string | null, sha = HEAD) =>
  () =>
    Response.json({ head: { sha }, body });

async function accountOf(subject: string) {
  const [identity] = await db.select().from(identities).where(eq(identities.subject, subject));
  return identity?.accountId ?? "";
}

async function share(accountId: string) {
  await db.update(accounts).set({ shareFindings: true }).where(eq(accounts.id, accountId));
}

const WALKTHROUGH = {
  overview: "Adds <b>retries</b> to the client <!-- ocra:description:end -->",
  groups: [
    { title: "Client", files: ["src/client.ts", "src/my_retry.ts"], note: "Retries on 503" },
  ],
  diagram: null,
};

/** A PR-mode review of the account, with one shared finding and a walkthrough. */
async function seed(
  accountId: string,
  pull: { repository: string; number: number; head?: string; runId?: string },
  sharing = true,
) {
  const data = scoped(db, accountId);
  const { reviewersDropped: _, ...row } = reviewRow(
    reviewUploadSchema.parse({
      ...upload(pull.runId ?? "run-1", []),
      verdict: "minor_issues",
      findings: { critical: 1, warning: 2, suggestion: 0 },
      pullRequest: { repository: pull.repository, number: pull.number, headSha: pull.head ?? HEAD },
      linkedTasks: [
        {
          tracker: "jira",
          key: "PAY-12",
          url: "https://jira.example.com/browse/PAY-12",
          state: "open",
          title: "Refund @team",
        },
        { tracker: "github", key: "#3", url: "javascript:alert(1)", state: null },
        {
          tracker: "tapd",
          key: "T-9",
          url: "https://user:pass@tapd.example.com/9",
          state: "closed",
        },
      ],
    }),
  );
  const [shared] = parseFindings([
    finding({ title: "SQL **built** <img src=x onerror=alert(1)> from [input](http://x)" }),
  ]).rows;
  if (!shared) throw new Error("the finding was not read");
  const stored = await data.insertReview(row, sharing ? [shared] : [], {
    dailyUploads: 10,
    maxFindings: 10,
  });
  if (stored.outcome !== "stored") throw new Error(stored.outcome);
  const walkthrough = parseWalkthrough(WALKTHROUGH);
  if (sharing && walkthrough) {
    await data.insert("reviewWalkthroughs", { ...walkthrough, reviewId: stored.id });
  }
  return stored.id;
}

const draftOf = async (a: Signed, query: string) => {
  const res = await a.send(`/api/pulls/description-draft?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as PullDescriptionDraftView;
};

const save = (a: Signed, body: Record<string, unknown>) =>
  a.send("/api/pulls/description", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const GITHUB_QUERY = "platform=github&repo=octo/api&number=7";
const ref = { platform: "github", repo: "octo/api", number: 7 };

/** The draft's own section, markers included. */
const sectionOf = (draft: string | null) => {
  const text = draft ?? "";
  return text.slice(text.indexOf(DESCRIPTION_START), text.indexOf(DESCRIPTION_END));
};

describe("a draft description on GitHub", () => {
  it("is built from the review of the head now, after the user's own text", async () => {
    platform({ [`GET ${PULL}`]: githubPull("Fixes refunds.\n\nMore of mine.") });
    const a = await signInWithGithub();
    const account = await accountOf("42");
    await share(account);
    const id = await seed(account, { repository: "https://github.com/octo/api", number: 7 });
    const view = await draftOf(a, GITHUB_QUERY);
    expect(view.head).toBe(HEAD);
    expect(view.body).toBe("Fixes refunds.\n\nMore of mine.");
    expect(view.review).toMatchObject({ id, head: HEAD, current: true });
    const draft = view.draft ?? "";
    expect(
      draft.startsWith("Fixes refunds.\n\nMore of mine.\n\n<!-- ocra:description:start -->"),
    ).toBe(true);
    expect(draft).toContain("ocra found minor issues.");
    expect(draft).toContain("- **Client**: Retries on 503 (src/client.ts, src/my\\_retry.ts)");
    expect(draft).toContain(
      "- [PAY-12](https://jira.example.com/browse/PAY-12): Refund \\@\u200Bteam (open)",
    );
    // Only an https address is a link.
    expect(draft).toContain("- \\#3\n");
    expect(draft).not.toContain("javascript:");
    // Nor is one that carries credentials.
    expect(draft).toContain("- T-9 (closed)");
    expect(draft).not.toContain("pass@");
    expect(draft).toContain("- 1 critical\n  - SQL \\*\\*built\\*\\* &lt;img");
    expect(draft).toContain(
      "_Drafted by ocra from its review of `aaaaaaaaaaaa`, the current head._",
    );
    // The review's text adds no HTML and cannot end ocra's section early.
    const section = sectionOf(draft);
    expect(section).not.toMatch(/<(?!!-- ocra:description:start -->)/);
    expect(draft.split(DESCRIPTION_END)).toHaveLength(2);
  });

  it("replaces only ocra's section of a description that has one", async () => {
    const before = `Mine first.\n\n${DESCRIPTION_START}\nold draft\n${DESCRIPTION_END}\n\nMine after.`;
    platform({ [`GET ${PULL}`]: githubPull(before) });
    const a = await signInWithGithub();
    await seed(await accountOf("42"), { repository: "https://github.com/octo/api", number: 7 });
    const draft = (await draftOf(a, GITHUB_QUERY)).draft ?? "";
    expect(draft.startsWith(`Mine first.\n\n${DESCRIPTION_START}`)).toBe(true);
    expect(draft.endsWith(`${DESCRIPTION_END}\n\nMine after.`)).toBe(true);
    expect(draft).not.toContain("old draft");
  });

  it("states counts only, without finding titles, when the account does not share findings", async () => {
    platform({ [`GET ${PULL}`]: githubPull(null) });
    const a = await signInWithGithub();
    await seed(
      await accountOf("42"),
      { repository: "https://github.com/octo/api", number: 7 },
      false,
    );
    const view = await draftOf(a, GITHUB_QUERY);
    expect(view.body).toBe("");
    const draft = view.draft ?? "";
    expect(draft).toContain("### Risk notes\n\n1 critical, 2 warnings, 0 suggestions.");
    expect(draft).not.toContain("SQL");
    expect(draft).not.toContain("Refund");
    expect(draft).not.toContain("### Changes");
  });

  it("falls back to the newest review of an earlier head, and says so", async () => {
    platform({ [`GET ${PULL}`]: githubPull("") });
    const a = await signInWithGithub();
    await seed(await accountOf("42"), {
      repository: "https://github.com/octo/api",
      number: 7,
      head: OLD,
    });
    const view = await draftOf(a, GITHUB_QUERY);
    expect(view.review).toMatchObject({ head: OLD, current: false });
    expect(view.draft).toContain(
      "its review of `bbbbbbbbbbbb`, an earlier head, not the current one.",
    );
  });

  it("answers no draft for a pull request ocra has not reviewed", async () => {
    platform({ [`GET ${PULL}`]: githubPull("Mine.") });
    const a = await signInWithGithub();
    await seed(await accountOf("42"), { repository: "https://github.com/octo/api", number: 8 });
    expect(await draftOf(a, GITHUB_QUERY)).toEqual({
      head: HEAD,
      body: "Mine.",
      draft: null,
      review: null,
    });
  });

  it("never drafts from another account's review of the same pull request", async () => {
    platform({ [`GET ${PULL}`]: githubPull("") });
    const other = await signIn(9, "mallory");
    await share(other.account.id);
    await seed(other.account.id, { repository: "https://github.com/octo/api", number: 7 });
    const a = await signInWithGithub();
    const view = await draftOf(a, GITHUB_QUERY);
    expect(view.draft).toBeNull();
    expect(view.review).toBeNull();
  });
});

describe("saving a description on GitHub", () => {
  it("edits the pull request's body as the user on the head drafted on", async () => {
    const sent = platform({
      [`GET ${PULL}`]: githubPull("x"),
      [`PATCH ${PULL}`]: () => Response.json({}),
    });
    const a = await signInWithGithub();
    const res = await save(a, { ...ref, head: HEAD, body: "Edited." });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent).toEqual([{ method: "PATCH", url: PULL, body: { body: "Edited." } }]);
  });

  it("sends nothing once the pull request moved", async () => {
    const sent = platform({ [`GET ${PULL}`]: githubPull("x", OLD) });
    const a = await signInWithGithub();
    const res = await save(a, { ...ref, head: HEAD, body: "Edited." });
    expect(await res.json()).toEqual({ outcome: "head_moved" });
    expect(sent).toEqual([]);
  });

  it("refuses a body longer than the platform takes, unsent", async () => {
    const sent = platform({ [`GET ${PULL}`]: githubPull("x") });
    const a = await signInWithGithub();
    const body = "x".repeat(MAX_DESCRIPTION_CHARS + 1);
    const res = await save(a, { ...ref, head: HEAD, body });
    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("answers the platform's refusal as one", async () => {
    platform({
      [`GET ${PULL}`]: githubPull("x"),
      [`PATCH ${PULL}`]: () => new Response(null, { status: 403 }),
    });
    const a = await signInWithGithub();
    const res = await save(a, { ...ref, head: HEAD, body: "Edited." });
    expect(await res.json()).toEqual({ outcome: "refused" });
  });
});

describe("a description on GitLab", () => {
  const gitlabMr =
    (description: string | null, sha = HEAD) =>
    () =>
      Response.json({ sha, description });
  const query = `platform=gitlab&repo=${encodeURIComponent("Group/Sub/Project")}&number=3`;
  const mrRef = { platform: "gitlab", repo: "Group/Sub/Project", number: 3 };

  it("drafts from the merge request's review, keeping the user's text around ocra's section", async () => {
    const before = `Mine.\n\n${DESCRIPTION_START}\nold\n${DESCRIPTION_END}`;
    platform({ [`GET ${MR}`]: gitlabMr(before) });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    await seed(await accountOf("42"), {
      repository: "https://gitlab.example.com/group/sub/project",
      number: 3,
    });
    const view = await draftOf(a, query);
    expect(view.review).toMatchObject({ current: true });
    expect(view.draft?.startsWith(`Mine.\n\n${DESCRIPTION_START}`)).toBe(true);
    expect(view.draft?.endsWith(DESCRIPTION_END)).toBe(true);
    expect(view.draft).not.toContain("\nold\n");
  });

  it("answers no draft when only another merge request was reviewed", async () => {
    platform({ [`GET ${MR}`]: gitlabMr(null) });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    await seed(await accountOf("42"), {
      repository: "https://gitlab.example.com/group/sub/other",
      number: 3,
    });
    expect((await draftOf(a, query)).draft).toBeNull();
  });

  it("puts the description as the user, and sends nothing once the merge request moved", async () => {
    let sha = HEAD;
    const sent = platform({
      [`GET ${MR}`]: () => gitlabMr("x", sha)(),
      [`PUT ${MR}`]: () => Response.json({}),
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const done = await save(a, { ...mrRef, head: HEAD, body: "Edited." });
    expect(await done.json()).toEqual({ outcome: "done" });
    expect(sent).toEqual([{ method: "PUT", url: MR, body: { description: "Edited." } }]);
    sha = OLD;
    const moved = await save(a, { ...mrRef, head: HEAD, body: "Again." });
    expect(await moved.json()).toEqual({ outcome: "head_moved" });
    expect(sent).toHaveLength(1);
  });
});

describe("the description's template", () => {
  it("appends a section to a body with no complete one, so a stray marker swallows nothing", () => {
    const body = `Mine ${DESCRIPTION_START} still mine.`;
    const section = `${DESCRIPTION_START}\nnew\n${DESCRIPTION_END}`;
    const once = withSection(body, section);
    expect(once).toBe(`${body}\n\n${section}\n`);
    const twice = withSection(once, `${DESCRIPTION_START}\nnewer\n${DESCRIPTION_END}`);
    expect(twice).toBe(`${body}\n\n${DESCRIPTION_START}\nnewer\n${DESCRIPTION_END}\n`);
  });

  it("writes the review's text as one line of plain text", () => {
    expect(inline("a\n<!-- x -->\n**b** [c](d) `e` @f #1 &amp;")).toBe(
      "a &lt;\\!-- x --&gt; \\*\\*b\\*\\* \\[c\\]\\(d\\) \\`e\\` \\@\u200Bf \\#1 &amp;amp;",
    );
  });
});
