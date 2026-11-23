import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PullPage } from "./pages/PullPage.js";
import { anchorOf, parsePatch } from "./pull/diff.js";
import { ToastProvider } from "./toast.js";

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

const NO_QUEUE = { ahead: [], size: null, removed: null };

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
  title: "Cap refunds at the order total",
  author: "ada",
  url: "https://github.com/octo/api/pull/7",
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
      viewed: false,
    },
  ],
  truncated: false,
  verdicts: ["approve", "request_changes", "comment"],
  mergeMethods: ["squash", "merge"],
};

const noReviewers = { suggestions: [], owners: [] };
const suggestion = (id: string, applicable: boolean) => ({
  id,
  startLine: 11,
  endLine: 11,
  replacement: "if (amount > left) return;",
  applicable,
  applied: false,
});
const threads = {
  head: HEAD,
  truncated: false,
  threads: [
    {
      id: "T1",
      path: "src/refund.ts",
      line: 11,
      startLine: null,
      side: "new",
      resolved: false,
      outdated: false,
      canResolve: true,
      comments: [
        {
          id: "C1",
          author: "rev",
          body: "Return early.",
          createdAt: null,
          suggestions: [suggestion("C1:0", true)],
        },
        {
          id: "C2",
          author: "rev",
          body: "Or this.",
          createdAt: null,
          suggestions: [suggestion("C2:0", false)],
        },
      ],
    },
  ],
};

const labels = {
  applied: ["bug"],
  available: [
    { name: "bug", color: "#d73a4a", description: "Something is wrong" },
    { name: "docs", color: null, description: null },
  ],
  truncated: false,
};
const draft = { draft: true, state: "open" };
const readiness = {
  ready: "ready",
  items: [{ kind: "conflicts", state: "met", detail: "No conflicts" }],
  codeOwners: [],
  staleApprovals: [],
  otherRules: [],
};

const noReadiness = { ready: null, items: [], codeOwners: [], staleApprovals: [], otherRules: [] };

describe("a pull request's page", () => {
  const show = (
    queue: unknown = { enabled: false, entry: null, ...NO_QUEUE },
    listed: unknown = files,
    platform = "github",
    routes: Record<string, unknown> = {},
  ) => {
    const sent: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          sent.push({ url, body: JSON.parse(String(init.body)) });
          return Response.json({
            outcome: url.endsWith("/merge") ? "head_moved" : "done",
            items: [],
          });
        }
        const routed = Object.entries(routes).find(([path]) => url.startsWith(path));
        if (routed) return Response.json(routed[1]);
        if (url.startsWith("/api/pulls/readiness")) return Response.json(noReadiness);
        if (url.startsWith("/api/pulls/stack")) return Response.json({ trunk: "", pulls: [] });
        if (url.startsWith("/api/pulls/reviewers")) return Response.json(noReviewers);
        if (url.startsWith("/api/pulls/threads")) return Response.json(threads);
        if (url.startsWith("/api/pulls/labels")) return Response.json(labels);
        if (url.startsWith("/api/pulls/draft")) return Response.json(draft);
        if (url.startsWith("/api/pulls/description-draft")) {
          return Response.json({ head: HEAD, body: "", draft: null, review: null });
        }
        return Response.json(url.startsWith("/api/pulls/queue") ? queue : listed);
      }),
    );
    render(
      <ToastProvider>
        <PullPage platform={platform} repo="octo/api" number="7" />
      </ToastProvider>,
    );
    return sent;
  };

  it("heads the page with the pull request's title, its author and a link to it", async () => {
    show();
    expect(
      await screen.findByRole("heading", { name: "Cap refunds at the order total" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "octo/api #7" }).getAttribute("href")).toBe(
      "https://github.com/octo/api/pull/7",
    );
    expect(screen.getByText(/ada/)).toBeTruthy();
    await waitFor(() =>
      expect(document.title).toBe("#7 Cap refunds at the order total · ocra Cloud"),
    );
  });

  it("sends a review with its line comments against the head it read", async () => {
    const sent = show();
    fireEvent.click(await screen.findByRole("button", { name: "Comment on removed line 11" }));
    fireEvent.change(screen.getByLabelText("Your comment on removed line 11"), {
      target: { value: "Why log?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
    fireEvent.click(screen.getByRole("button", { name: "Review changes 1" }));
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
    expect(await screen.findByText("Review sent")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Your review" })).toBeNull();
    expect(screen.queryByText("Why log?")).toBeNull();
  });

  it("ticks a file as viewed at the head it read, folds it and counts it", async () => {
    const sent = show();
    const box = await screen.findByRole("checkbox", { name: "Viewed src/refund.ts" });
    expect(screen.getByText(/0 of 1 files viewed/)).toBeTruthy();
    await act(async () => void fireEvent.click(box));
    expect(sent).toEqual([
      {
        url: "/api/pulls/viewed",
        body: {
          platform: "github",
          repo: "octo/api",
          number: 7,
          head: HEAD,
          paths: ["src/refund.ts"],
          viewed: true,
        },
      },
    ]);
    expect(await screen.findByText(/1 of 1 files viewed/)).toBeTruthy();
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("button", { name: "Comment on line 11" })).toBeNull();
  });

  it("opens a file already viewed folded, with its tick in the file list", async () => {
    show(undefined, {
      ...files,
      files: files.files.map((f) => ({ ...f, viewed: true })),
    });
    const box = await screen.findByRole("checkbox", { name: "Viewed src/refund.ts" });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/1 of 1 files viewed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Comment on line 11" })).toBeNull();
    expect(screen.getByTitle("src/refund.ts (changed, viewed)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { expanded: false, name: /refund\.ts/ }));
    expect(screen.getByRole("button", { name: "Comment on line 11" })).toBeTruthy();
  });

  it("offers a merged pull request a comment, and no verdict, merge, readiness or draft switch", async () => {
    show(
      undefined,
      { ...files, state: "merged", verdicts: ["comment"], mergeMethods: [] },
      "github",
      {
        "/api/pulls/readiness": readiness,
      },
    );
    expect(await screen.findByText(/This pull request is merged/)).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Merge readiness" })).toBeNull();
    expect(screen.queryByRole("button", { name: /draft|ready for review/i })).toBeNull();
    expect(screen.getByText("Merged").className).toContain("badge");
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByRole("button", { name: "Submit review" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Verdict" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge pull request" })).toBeNull();
  });

  it("names a rebase the way each platform does", async () => {
    show(undefined, { ...files, mergeMethods: ["rebase"] });
    expect(await screen.findAllByRole("option", { name: "Rebase and merge" })).not.toHaveLength(0);
    cleanup();
    show(undefined, { ...files, mergeMethods: ["rebase"] }, "gitlab");
    expect(await screen.findAllByRole("option", { name: "Fast-forward merge" })).not.toHaveLength(
      0,
    );
    expect(screen.queryByRole("option", { name: "Rebase and merge" })).toBeNull();
  });

  it("writes a suggestion on a new line into the review", async () => {
    const sent = show();
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 11" }));
    fireEvent.click(screen.getByRole("button", { name: "Suggest a change" }));
    fireEvent.change(screen.getByLabelText("Suggested text for line 11"), {
      target: { value: "if (amount > left) return;" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
    fireEvent.click(screen.getByRole("button", { name: "Review changes 1" }));
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Submit review" })),
    );
    expect(sent[0]?.body).toMatchObject({
      comments: [
        {
          path: "src/refund.ts",
          line: 11,
          side: "new",
          body: "",
          suggestion: "if (amount > left) return;",
        },
      ],
    });
  });

  it("commits the picked suggestions with the page's other chosen changes, and resolves", async () => {
    const sent = show();
    const panel = await screen.findByRole("region", { name: "Review threads" });
    const [apply, outdated] = within(panel).getAllByRole("checkbox");
    expect((outdated as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(apply as HTMLElement);
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Commit 1 change" })),
    );
    await act(
      async () => void fireEvent.click(within(panel).getByRole("button", { name: "Resolve" })),
    );
    expect(sent).toEqual([
      {
        url: "/api/pulls/apply-batch",
        body: {
          platform: "github",
          repo: "octo/api",
          number: 7,
          head: HEAD,
          items: [{ kind: "suggestion", id: "C1:0" }],
        },
      },
      {
        url: "/api/pulls/resolve-thread",
        body: { platform: "github", repo: "octo/api", number: 7, thread: "T1", resolved: true },
      },
    ]);
  });

  it("replies in a thread as the user, and closes the box once it is sent", async () => {
    const sent = show();
    const panel = await screen.findByRole("region", { name: "Review threads" });
    fireEvent.click(within(panel).getByRole("button", { name: "Reply" }));
    const send = within(panel).getByRole("button", { name: "Send reply" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText("Reply"), {
      target: { value: " Done in abc. " },
    });
    await act(async () => void fireEvent.click(send));
    expect(sent).toEqual([
      {
        url: "/api/pulls/reply-thread",
        body: {
          platform: "github",
          repo: "octo/api",
          number: 7,
          thread: "T1",
          body: "Done in abc.",
        },
      },
    ]);
    await waitFor(() => expect(within(panel).queryByLabelText("Reply")).toBeNull());
  });

  it("leads a draft with marking it ready, and names what is in its way in the head", async () => {
    const sent = show(undefined, files, "github", {
      "/api/pulls/readiness": {
        ...noReadiness,
        ready: "unmet",
        items: [
          { kind: "draft", state: "unmet", detail: "Still a draft" },
          { kind: "conflicts", state: "unmet", detail: "Conflicts with the base branch" },
        ],
      },
    });
    const head = within(await screen.findByRole("banner"));
    expect((await head.findByText("Conflicts")).className).toContain("badge-err");
    expect(head.getByText("Draft")).toBeTruthy();
    const ready = head.getByRole("button", { name: "Mark ready for review" });
    const primary = (b: HTMLElement) => b.className.includes("bg-primary");
    expect(primary(ready)).toBe(true);
    expect(primary(head.getByRole("button", { name: "Review changes" }))).toBe(false);
    await act(async () => void fireEvent.click(ready));
    expect(sent).toEqual([
      {
        url: "/api/pulls/draft",
        body: { platform: "github", repo: "octo/api", number: 7, draft: false },
      },
    ]);
  });

  it("shows the labels on it, and adds one of the repository's from the menu", async () => {
    const sent = show();
    const box = await screen.findByRole("region", { name: "Labels" });
    expect(within(box).getByText("bug")).toBeTruthy();
    expect(within(box).queryByText("docs")).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: "Edit" }));
    const docs = await screen.findByRole("menuitemcheckbox", { name: "docs" });
    expect(screen.getByRole("menuitemcheckbox", { name: "bug" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await act(async () => void fireEvent.click(docs));
    expect(sent).toEqual([
      {
        url: "/api/pulls/labels",
        body: { platform: "github", repo: "octo/api", number: 7, add: ["docs"], remove: [] },
      },
    ]);
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
        if (url.startsWith("/api/pulls/stack")) return Response.json({ trunk: "", pulls: [] });
        if (url.startsWith("/api/pulls/reviewers")) return Response.json(noReviewers);
        if (url.startsWith("/api/pulls/threads")) return Response.json(threads);
        if (url.startsWith("/api/pulls/labels")) return Response.json(labels);
        if (url.startsWith("/api/pulls/draft")) return Response.json(draft);
        if (url.startsWith("/api/pulls/description-draft")) {
          return Response.json({ head: HEAD, body: "", draft: null, review: null });
        }
        if (url.startsWith("/api/pulls/readiness")) return Response.json(noReadiness);
        return Response.json(files);
      }),
    );
    render(
      <ToastProvider>
        <PullPage platform="github" repo="octo/api" number="7" runner />
      </ToastProvider>,
    );
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
    const sent = show({ enabled: true, entry: null, ...NO_QUEUE, size: 2 });
    expect(await screen.findByText(/2 pull requests in the queue now/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Merge pull request" })).toBeNull();
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Add to merge queue" })),
    );
    expect(sent).toEqual([
      {
        url: "/api/pulls/enqueue",
        body: { platform: "github", repo: "octo/api", number: 7, head: HEAD },
      },
    ]);
  });
});
