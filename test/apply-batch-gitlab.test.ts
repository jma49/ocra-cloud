import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullBatchView } from "../src/shared/index.js";
import { FILE, HEAD, seed } from "./fix-fakes.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// Several fixes and suggestions committed to a GitLab merge request as one
// commit through its commits API, each file guarded by its last commit.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}/merge_requests/3`;
const PROJECT = `${GITLAB}/api/v4/projects/9/repository`;
const file = (path: string) => `${PROJECT}/files/${encodeURIComponent(path)}?ref=${HEAD}`;

type Sent = { method: string; url: string; body: unknown };

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

const DISCUSSIONS = [
  {
    id: "d1".padEnd(40, "0"),
    notes: [
      {
        id: 1,
        type: "DiffNote",
        body: "```suggestion\nx = 2\n```",
        author: { username: "rev" },
        system: false,
        resolvable: true,
        resolved: false,
        position: {
          head_sha: HEAD,
          new_path: "app.rb",
          old_path: "app.rb",
          new_line: 2,
          old_line: null,
        },
        suggestions: [
          {
            id: 10,
            from_line: 2,
            to_line: 2,
            appliable: true,
            applied: false,
            from_content: "x = 1\n",
            to_content: "x = 2\n",
          },
        ],
      },
    ],
  },
];

const read = (text: string, last: string) => () =>
  Response.json({
    size: text.length,
    encoding: "base64",
    content: btoa(text),
    last_commit_id: last,
  });

describe("applying several fixes and suggestions as one commit on GitLab", () => {
  it("sends one commit with an action per file, each guarded by the file's last commit", async () => {
    const sent = platform({
      [`GET ${MR}`]: () =>
        Response.json({
          sha: HEAD,
          diff_refs: null,
          source_branch: "topic",
          source_project_id: 9,
        }),
      [`GET ${MR}/discussions?per_page=100&page=1`]: () => Response.json(DISCUSSIONS),
      [`GET ${file("src/db.ts")}`]: read(FILE, "c-db"),
      [`GET ${file("app.rb")}`]: read("puts 1\nx = 1\n", "c-app"),
      [`POST ${PROJECT}/commits`]: () => new Response("{}", { status: 201 }),
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const { id, data } = await seed("https://gitlab.example.com/group/sub/project", 3);
    const res = await a.send("/api/pulls/apply-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "gitlab",
        repo: "Group/Sub/Project",
        number: 3,
        head: HEAD,
        items: [
          { kind: "finding", id },
          { kind: "suggestion", id: "10" },
        ],
      }),
    });
    const view = (await res.json()) as PullBatchView;
    expect(view.outcome).toBe("done");
    expect(view.items.map((i) => i.applied)).toEqual([true, true]);
    // The suggestion goes in the same commit, not through GitLab's suggestion API.
    expect(sent.map((s) => s.url)).toEqual([`${PROJECT}/commits`]);
    const body = sent[0]?.body as {
      branch: string;
      commit_message: string;
      actions: { file_path: string; content: string; last_commit_id: string }[];
    };
    expect(body.branch).toBe("topic");
    expect(body.commit_message).toBe("Apply 1 fix from ocra and 1 suggestion");
    expect(body.actions.map((x) => [x.file_path, atob(x.content), x.last_commit_id])).toEqual([
      ["src/db.ts", "const a = 1;\nconst b = 20;\nconst c = 3;\n", "c-db"],
      ["app.rb", "puts 1\nx = 2\n", "c-app"],
    ]);
    expect(await data.get("findings", id)).toMatchObject({ fixedVia: "applied" });
  });
});
