import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResultsView } from "../../src/shared/index.js";
import { CommandMenu } from "./command-menu.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pull = {
  id: "p7",
  number: 7,
  title: "Cap refunds at what was captured",
  url: "https://github.com/octo/api/pull/7",
  repo: "octo/api",
  author: "sample-user",
  draft: false,
  state: "open",
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-21T00:00:00Z",
  mergedAt: null,
  checks: "passing",
  review: "none",
  additions: 2,
  deletions: 1,
  platform: "github",
  host: "github.com",
  to: "/pull/github/octo%2Fapi/7",
} as unknown as SearchResultsView["pulls"][number]["results"][number];

const answer = (query: string, over: Partial<SearchResultsView> = {}): SearchResultsView => ({
  query,
  jump: null,
  pulls: [
    { platform: "github", host: "github.com", linked: true, error: null, results: [pull] },
    { platform: "gitlab", host: "gitlab.com", linked: true, error: "unavailable", results: [] },
  ],
  reviews: [],
  findings: [
    {
      id: "f1",
      reviewId: "r1",
      title: "Refund can exceed the capture",
      file: "src/refund.ts",
      line: 11,
      severity: "critical",
      status: "open",
      to: "/reviews/r1",
    },
  ],
  repositories: [],
  destinations: [],
  ...over,
});

const sections = [
  { value: "Insights", items: [{ label: "Usage", to: "/usage", within: "Insights" }] },
];

function open(answers: (query: string) => SearchResultsView) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const query = new URL(url, "http://x").searchParams.get("q") ?? "";
      asked.push(query);
      return Response.json(answers(query));
    }),
  );
  render(<CommandMenu sections={sections} />);
  fireEvent.keyDown(document, { key: "k", ctrlKey: true });
  return asked;
}

describe("the command menu's search", () => {
  it("asks once the typing stops, lists what was found and opens a result", async () => {
    history.replaceState(null, "", "/");
    const asked = open((q) => answer(q));
    const input = await screen.findByPlaceholderText("Search or go to…");
    fireEvent.change(input, { target: { value: "r" } });
    fireEvent.change(input, { target: { value: "ref" } });
    fireEvent.change(input, { target: { value: "  refund " } });
    const found = await screen.findByRole("option", { name: /Cap refunds at what was captured/ });
    expect(asked).toEqual(["refund"]);
    expect(found.textContent).toContain("octo/api#7");
    expect(screen.getByRole("option", { name: /src\/refund.ts:11/ })).toBeTruthy();
    expect(screen.getByText("No answer from GitLab, so no pull requests from there.")).toBeTruthy();
    fireEvent.click(found);
    expect(location.pathname).toBe("/pull/github/octo%2Fapi/7");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("puts the pull request a reference names first, once", async () => {
    open((q) => answer(q, { jump: pull }));
    fireEvent.change(await screen.findByPlaceholderText("Search or go to…"), {
      target: { value: "octo/api#7" },
    });
    await screen.findByRole("option", { name: /Cap refunds/ });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Cap refunds at what was capturedocto/api#7",
      "Refund can exceed the capturesrc/refund.ts:11",
    ]);
  });

  it("keeps matching pages while the server is asked, and never follows a path off the console", async () => {
    history.replaceState(null, "", "/");
    open((q) =>
      answer(q, {
        pulls: [],
        findings: null,
        repositories: [
          {
            platform: "github",
            host: "github.com",
            fullName: "octo/usage",
            autoReview: false,
            codeGraph: false,
            to: "//elsewhere.example/usage",
          },
        ],
      }),
    );
    fireEvent.change(await screen.findByPlaceholderText("Search or go to…"), {
      target: { value: "usage" },
    });
    expect(screen.getByRole("option", { name: "Usage" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("option", { name: "octo/usage" }));
    expect(location.pathname).toBe("/");
  });
});
