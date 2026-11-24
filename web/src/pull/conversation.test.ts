import { describe, expect, it } from "vitest";
import type { PullFindingView, ReviewThreadView } from "../../../src/shared/index.js";
import { commentsByFile, conversationOf, groupConversation, jumpOf } from "./conversation.js";

const thread = (id: string, over: Partial<ReviewThreadView> = {}): ReviewThreadView => ({
  id,
  path: "src/a.ts",
  line: 3,
  startLine: null,
  side: "new",
  resolved: false,
  outdated: false,
  canResolve: true,
  comments: [
    { id: `${id}c`, author: "ana", body: `Look at ${id}`, createdAt: null, suggestions: [] },
  ],
  ...over,
});

const finding = (id: string, over: Partial<PullFindingView> = {}): PullFindingView => ({
  id,
  review: "r1",
  severity: "warning",
  title: `Finding ${id}`,
  body: "Text",
  file: "src/a.ts",
  lineStart: 2,
  lineEnd: 4,
  hasFix: false,
  lowConfidence: false,
  ...over,
});

const ocraBody = (title: string) =>
  `<!-- ocra:finding abc -->\n**${title}**\\\nwarning · correctness\n\nWhy it matters.`;

describe("conversationOf", () => {
  it("groups threads as open, outdated and resolved, with ocra's findings open", () => {
    const items = conversationOf(
      [
        thread("t1"),
        thread("t2", { outdated: true, line: null }),
        thread("t3", { resolved: true }),
        thread("t4", { resolved: true, outdated: true }),
      ],
      [finding("f1")],
    );
    const groups = groupConversation(items);
    expect(groups.open.map((i) => i.id)).toEqual(["thread:t1", "finding:f1"]);
    expect(groups.outdated.map((i) => i.id)).toEqual(["thread:t2"]);
    expect(groups.resolved.map((i) => i.id)).toEqual(["thread:t3", "thread:t4"]);
  });

  it("reads who wrote a thread and its first line, and ocra's own comment by its title", () => {
    const [mine, ocra] = conversationOf(
      [
        thread("t1", { line: 1 }),
        thread("t2", {
          line: 9,
          comments: [
            {
              id: "c",
              author: "ocra-bot",
              body: ocraBody("Null check"),
              createdAt: null,
              suggestions: [],
            },
          ],
        }),
      ],
      [],
    );
    expect(mine).toMatchObject({ author: "ana", ocra: false, title: "Look at t1" });
    expect(ocra).toMatchObject({ ocra: true, title: "Null check" });
  });

  it("lists a finding ocra posted as a thread once", () => {
    const posted = thread("t1", {
      comments: [
        {
          id: "c",
          author: "ocra-bot",
          body: ocraBody("Finding f1"),
          createdAt: null,
          suggestions: [],
        },
      ],
    });
    const items = conversationOf([posted], [finding("f1"), finding("f2")]);
    expect(items.map((i) => i.id).sort()).toEqual(["finding:f2", "thread:t1"]);
  });

  it("counts each file's comments and names its first conversation", () => {
    const items = conversationOf(
      [
        thread("t1", { line: 8 }),
        thread("t2", {
          line: 1,
          comments: [
            { id: "a", author: "x", body: "one", createdAt: null, suggestions: [] },
            { id: "b", author: "y", body: "two", createdAt: null, suggestions: [] },
          ],
        }),
        thread("t3", { path: "src/b.ts" }),
      ],
      [],
    );
    const byFile = commentsByFile(items);
    expect(byFile.get("src/a.ts")?.count).toBe(3);
    expect(byFile.get("src/a.ts")?.first.id).toBe("thread:t2");
    expect(byFile.get("src/b.ts")?.count).toBe(1);
  });
});

describe("jumpOf", () => {
  const files = [
    {
      path: "src/a.ts",
      oldPath: "src/a.ts",
      status: "modified" as const,
      additions: 1,
      deletions: 1,
      patch: "@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three",
      viewed: false,
    },
  ];
  const [item] = conversationOf([thread("t1")], []);
  if (!item) throw new Error("no item");

  it("finds a new line by its index in the patch", () => {
    expect(jumpOf(files, { ...item, line: 2 }, 4)).toEqual({
      path: "src/a.ts",
      line: 3,
      from: 0,
      to: 0,
      step: 4,
    });
  });

  it("finds a removed line on the old side", () => {
    expect(jumpOf(files, { ...item, line: 2, side: "old" }, 1)?.line).toBe(2);
  });

  it("has no line for an outdated thread, a line not in the diff or a file not shown", () => {
    expect(jumpOf(files, { ...item, line: null }, 1)).toBeNull();
    expect(jumpOf(files, { ...item, line: 40 }, 1)).toBeNull();
    expect(jumpOf(files, { ...item, path: "src/z.ts" }, 1)).toBeNull();
  });
});
