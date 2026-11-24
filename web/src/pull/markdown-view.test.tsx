import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FileDiff } from "./file-diff.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "b".repeat(40);
const README = [
  "# Refunds",
  "",
  "Partial refunds are **capped** at what was captured.",
  "",
  '<script>alert("x")</script>',
  "",
  "- one",
  "- two",
];

/** Serves the file's lines at the head, as the lines route does, and keeps what was asked. */
const serve = (lines: string[]) => {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      const q = new URL(url, "http://x").searchParams;
      const from = Number(q.get("from"));
      const to = Number(q.get("to"));
      return Response.json({
        path: q.get("path"),
        head: q.get("head"),
        from,
        lines: lines.slice(from - 1, to),
        total: lines.length,
      });
    }),
  );
  return asked;
};

const show = (path: string, status: "modified" | "removed" = "modified") =>
  render(
    <FileDiff
      context={{ pull: { platform: "github", repo: "acme/pay", number: 4 }, head: HEAD }}
      file={{
        path,
        oldPath: path,
        status,
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,2 @@\n # Refunds\n+Partial refunds are **capped** at what was captured.",
        viewed: false,
      }}
      layout="unified"
      viewed={false}
      onViewed={() => undefined}
      pending={[]}
      onComment={() => undefined}
      onDrop={() => undefined}
      findings={[]}
      review={null}
      fixes={[]}
      onDecided={() => undefined}
      onFixDone={() => undefined}
    />,
  );

it("draws a Markdown file as its page, read whole at the head, without its HTML", async () => {
  const asked = serve(README);
  show("docs/README.md");
  expect(document.querySelector("table.diff")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Refunds" })).toBeTruthy());
  expect(asked.at(-1)).toContain(`head=${HEAD}`);
  expect(asked.at(-1)).toContain("path=docs%2FREADME.md");
  expect(document.querySelector(".diff-rendered strong")?.textContent).toBe("capped");
  expect(document.querySelectorAll(".diff-rendered li")).toHaveLength(2);
  expect(document.querySelector(".diff-rendered script")).toBeNull();
  expect(document.querySelector("table.diff")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Diff" }));
  expect(document.querySelector("table.diff")).not.toBeNull();
});

it("reads a long file in the route's chunks until its end", async () => {
  const lines = Array.from({ length: 2300 }, (_, i) => `line ${i + 1}`);
  const asked = serve(lines);
  show("CHANGELOG.markdown");
  fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
  await waitFor(() =>
    expect(document.querySelector(".diff-rendered")?.textContent).toContain("line 2300"),
  );
  // The diff's own read-ahead of the lines after its hunk (from 3) is not the page's.
  const from = asked.map((u) => new URL(u, "http://x").searchParams.get("from"));
  expect(from.filter((f) => f !== "3")).toEqual(["1", "1001", "2001"]);
});

it("says so when the file cannot be read, and offers no page for other files", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 502 })),
  );
  show("README.md");
  fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not read"));
  cleanup();
  show("src/refunds.ts");
  expect(screen.queryByRole("button", { name: "Rendered" })).toBeNull();
  cleanup();
  show("README.md", "removed");
  expect(screen.queryByRole("button", { name: "Rendered" })).toBeNull();
});
