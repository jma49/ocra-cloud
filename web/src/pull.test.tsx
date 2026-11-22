import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PullPage } from "./pages/PullPage.js";
import { anchorOf, parsePatch } from "./pull/diff.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PATCH = [
  "@@ -10,4 +10,5 @@ export function refund(",
  " const left = charge.captured;",
  "-if (amount > charge.amount) {",
  "+if (amount > left) {",
  "+  log(amount);",
  "   throw new RefundTooLarge(amount);",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("a file's diff", () => {
  it("numbers each line on its side, and leaves out what is not a line of the file", () => {
    const lines = parsePatch(PATCH);
    expect(
      lines.map((l) => [l.kind, "old" in l ? l.old : null, "new" in l ? l.new : null]),
    ).toEqual([
      ["hunk", null, null],
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["context", 12, 13],
    ]);
  });

  it("anchors a comment on a removed line to the old side, any other to the new", () => {
    const [hunk, context, del, add] = parsePatch(PATCH);
    expect(hunk && anchorOf(hunk)).toBeNull();
    expect(context && anchorOf(context)).toEqual({ line: 10, side: "new" });
    expect(del && anchorOf(del)).toEqual({ line: 11, side: "old" });
    expect(add && anchorOf(add)).toEqual({ line: 11, side: "new" });
  });
});

const HEAD = "a".repeat(40);
const files = {
  platform: "github",
  repo: "octo/api",
  number: 7,
  base: "b".repeat(40),
  head: HEAD,
  files: [
    {
      path: "src/refund.ts",
      oldPath: "src/refund.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: PATCH,
    },
  ],
  truncated: false,
  verdicts: ["approve", "request_changes", "comment"],
  mergeMethods: ["squash", "merge"],
};

describe("a pull request's page", () => {
  const show = (queue: unknown = { enabled: false, entry: null }) => {
    const sent: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          sent.push({ url, body: JSON.parse(String(init.body)) });
          return Response.json({ outcome: url.endsWith("/merge") ? "head_moved" : "done" });
        }
        return Response.json(url.startsWith("/api/pulls/queue") ? queue : files);
      }),
    );
    render(<PullPage platform="github" repo="octo/api" number="7" />);
    return sent;
  };

  it("sends a review with its line comments against the head it read", async () => {
    const sent = show();
    fireEvent.click(await screen.findByRole("button", { name: "Comment on removed line 11" }));
    fireEvent.change(screen.getByLabelText("Your comment on removed line 11"), {
      target: { value: "Why log?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Submit review" })),
    );
    expect(sent).toEqual([
      {
        url: "/api/pulls/review",
        body: {
          platform: "github",
          repo: "octo/api",
          number: 7,
          verdict: "request_changes",
          body: "",
          head: HEAD,
          comments: [{ path: "src/refund.ts", line: 11, side: "old", body: "Why log?" }],
        },
      },
    ]);
    expect(await screen.findByText(/Review: Done/)).toBeTruthy();
    expect(screen.queryByText("Why log?")).toBeNull();
  });

  it("merges only once confirmed, and says when the pull request moved", async () => {
    const sent = show();
    fireEvent.click(await screen.findByRole("button", { name: "Merge pull request" }));
    expect(sent).toEqual([]);
    await act(
      async () =>
        void fireEvent.click(screen.getByRole("button", { name: "Confirm: squash and merge" })),
    );
    expect(sent).toEqual([
      {
        url: "/api/pulls/merge",
        body: { platform: "github", repo: "octo/api", number: 7, method: "squash", head: HEAD },
      },
    ]);
    expect(await screen.findByText(/gained commits since this page loaded/)).toBeTruthy();
  });

  it("asks the server's runner for tests on the head it read, once", async () => {
    const sent: { url: string; body: unknown }[] = [];
    let jobs: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          sent.push({ url, body: JSON.parse(String(init.body)) });
          jobs = [{ kind: "tests", head: HEAD, state: "queued", error: null, finishedAt: null }];
          return Response.json({ queued: true });
        }
        if (url.startsWith("/api/auto-review/generate")) {
          return Response.json({ enrolled: true, jobs });
        }
        return Response.json(files);
      }),
    );
    render(<PullPage platform="github" repo="octo/api" number="7" runner />);
    const generate = await screen.findByRole("button", { name: "Generate unit tests" });
    await act(async () => void fireEvent.click(generate));
    expect(sent).toEqual([
      {
        url: "/api/auto-review/generate",
        body: { platform: "github", repo: "octo/api", number: 7, head: HEAD, kind: "tests" },
      },
    ]);
    expect(await screen.findByText("Tests for this head: queued.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Generate unit tests" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("queues the head it read in place of a merge on a branch with a queue", async () => {
    const sent = show({ enabled: true, entry: null });
    fireEvent.click(await screen.findByRole("button", { name: "Add to merge queue" }));
    expect(screen.queryByRole("button", { name: "Merge pull request" })).toBeNull();
    await act(
      async () =>
        void fireEvent.click(screen.getByRole("button", { name: "Confirm: add to queue" })),
    );
    expect(sent).toEqual([
      {
        url: "/api/pulls/enqueue",
        body: { platform: "github", repo: "octo/api", number: 7, head: HEAD },
      },
    ]);
  });

  it("shows a queued pull request's place in line, and takes it out", async () => {
    const sent = show({ enabled: true, entry: { state: "checking", position: 3 } });
    expect(await screen.findByText(/#3 in line/)).toBeTruthy();
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Remove from queue" })),
    );
    expect(sent).toEqual([
      { url: "/api/pulls/dequeue", body: { platform: "github", repo: "octo/api", number: 7 } },
    ]);
  });
});
