import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identities } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { parseFindings } from "../src/findings.js";
import { reviewRow } from "../src/reviews.js";
import { finding, upload } from "./finding-uploads.js";
import { db, resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// Committing a finding's fix to the pull request it was found on, as the
// signed-in user: the file as the review saw it, with the fix's lines replaced.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const PULL = "https://api.github.com/repos/octo/api/pulls/7";
const CONTENTS = "https://api.github.com/repos/octo/api/contents/src/db.ts";
const FILE = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
const FIX = { fixStartLine: 2, fixEndLine: 2, fixReplacement: "const b = 20;" };

const b64 = (text: string) => btoa(text);
const unb64 = (text: string) => atob(text);

type Sent = { method: string; url: string; body: unknown };

/** Answers the routes given, by method and URL, and records every write. */
function platform(routes: Record<string, () => Response>) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      if (req.method !== "GET")
        sent.push({ method: req.method, url: req.url, body: await req.json() });
      return route();
    },
  });
  return sent;
}

/** A PR-mode review of the signed-in account with one finding; the finding's id. */
async function seed(repository: string, number: number, over: Record<string, unknown> = {}) {
  const [identity] = await db.select().from(identities).where(eq(identities.subject, "42"));
  const data = scoped(db, identity?.accountId ?? "");
  const { reviewersDropped: _, ...row } = reviewRow(
    // The contract's schema fills the defaults the route's body would have.
    reviewUploadSchema.parse({
      ...upload("run-1", []),
      pullRequest: { repository, number, headSha: HEAD },
    }),
  );
  const [shared] = parseFindings([finding()]).rows;
  if (!shared) throw new Error("the finding was not read");
  const stored = await data.insertReview(row, [{ ...shared, ...FIX, ...over }], {
    dailyUploads: 10,
    maxFindings: 10,
  });
  if (stored.outcome !== "stored") throw new Error(stored.outcome);
  const [f] = await data.findingsOf(stored.id);
  return { id: f?.id ?? "", data };
}

const apply = (a: Awaited<ReturnType<typeof signInWithGithub>>, id: string) =>
  a.send("/api/pulls/apply-fix", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ finding: id }),
  });

const githubPull = (sha = HEAD) =>
  Response.json({ head: { sha, ref: "feature", repo: { full_name: "octo/api" } } });

describe("applying a finding's fix on GitHub", () => {
  it("commits the file at the reviewed head with the lines replaced, and marks the finding fixed", async () => {
    const sent = platform({
      [`GET ${PULL}`]: () => githubPull(),
      [`GET ${CONTENTS}?ref=${HEAD}`]: () =>
        Response.json({
          type: "file",
          sha: "blob1",
          size: FILE.length,
          encoding: "base64",
          content: b64(FILE),
        }),
      [`PUT ${CONTENTS}`]: () => Response.json({ commit: { sha: MOVED } }),
    });
    const a = await signInWithGithub();
    const { id, data } = await seed("https://github.com/octo/api", 7);
    const res = await apply(a, id);
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body as { content: string; sha: string; branch: string; message: string };
    expect(unb64(body.content)).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
    expect(body).toMatchObject({ sha: "blob1", branch: "feature" });
    expect(body.message).toBe("Apply ocra's fix: SQL built from input");
    expect((await data.get("findings", id))?.status).toBe("fixed");
  });

  it("commits nothing on a pull request that moved since the review", async () => {
    const sent = platform({ [`GET ${PULL}`]: () => githubPull(MOVED) });
    const a = await signInWithGithub();
    const { id, data } = await seed("https://github.com/octo/api", 7);
    expect(await (await apply(a, id)).json()).toEqual({ outcome: "head_moved" });
    expect(sent).toEqual([]);
    expect((await data.get("findings", id))?.status).toBe("open");
  });

  it("refuses when the fork the pull request came from is gone", async () => {
    const sent = platform({
      [`GET ${PULL}`]: () => Response.json({ head: { sha: HEAD, ref: "feature", repo: null } }),
    });
    const a = await signInWithGithub();
    const { id } = await seed("https://github.com/octo/api", 7);
    expect(await (await apply(a, id)).json()).toEqual({ outcome: "refused" });
    expect(sent).toEqual([]);
  });

  it("commits nothing when the fix's lines are not in the file", async () => {
    const sent = platform({
      [`GET ${PULL}`]: () => githubPull(),
      [`GET ${CONTENTS}?ref=${HEAD}`]: () =>
        Response.json({
          type: "file",
          sha: "blob1",
          size: 4,
          encoding: "base64",
          content: b64("x\n"),
        }),
    });
    const a = await signInWithGithub();
    const { id } = await seed("https://github.com/octo/api", 7);
    expect(await (await apply(a, id)).json()).toEqual({ outcome: "not_applicable" });
    expect(sent).toEqual([]);
  });

  it("refuses a path that leaves the repository without calling the platform", async () => {
    const sent = platform({});
    const fetched = vi.mocked(globalThis.fetch);
    const a = await signInWithGithub();
    const calls = fetched.mock.calls.length;
    const { id } = await seed("https://github.com/octo/api", 7, { file: "src/../../etc/passwd" });
    expect(await (await apply(a, id)).json()).toEqual({ outcome: "not_applicable" });
    expect(fetched.mock.calls.length).toBe(calls);
    expect(sent).toEqual([]);
  });

  it("answers not found for a finding without a fix, or not of a pull request", async () => {
    platform({});
    const a = await signInWithGithub();
    const noFix = await seed("https://github.com/octo/api", 7, {
      fixStartLine: null,
      fixEndLine: null,
      fixReplacement: null,
    });
    expect((await apply(a, noFix.id)).status).toBe(404);
    expect((await apply(a, "missing")).status).toBe(404);
  });
});

describe("applying a finding's fix on GitLab", () => {
  it("commits to the merge request's source branch, guarded by the file's last commit", async () => {
    const project = `${GITLAB}/api/v4/projects/9/repository`;
    const mr = `${GITLAB}/api/v4/projects/${encodeURIComponent("group/sub/project")}/merge_requests/3`;
    const sent = platform({
      [`GET ${mr}`]: () =>
        Response.json({ sha: HEAD, diff_refs: null, source_branch: "topic", source_project_id: 9 }),
      [`GET ${project}/files/${encodeURIComponent("src/db.ts")}?ref=${HEAD}`]: () =>
        Response.json({
          size: FILE.length,
          encoding: "base64",
          content: b64(FILE.replaceAll("\n", "\r\n")),
          last_commit_id: "c1",
        }),
      [`POST ${project}/commits`]: () => new Response("{}", { status: 201 }),
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const { id } = await seed("https://gitlab.example.com/group/sub/project", 3);
    expect(await (await apply(a, id)).json()).toEqual({ outcome: "done" });
    const body = sent[0]?.body as {
      branch: string;
      actions: { content: string; last_commit_id: string }[];
    };
    expect(body.branch).toBe("topic");
    expect(body.actions[0]?.last_commit_id).toBe("c1");
    // The file's own line endings are kept.
    expect(unb64(body.actions[0]?.content ?? "")).toBe(
      "const a = 1;\r\nconst b = 20;\r\nconst c = 3;\r\n",
    );
  });
});
