import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphRepoView, ImpactSymbol, ImpactView } from "../../../src/shared/index.js";
import { clearCache } from "../cache.js";
import { graphRepoOf, lineUrl, symbolsOf } from "../impact/select.js";
import { ReviewDetail } from "./ReviewDetail.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const BASE = "b".repeat(40);
const repo: GraphRepoView = {
  id: "g1",
  platform: "github",
  host: "github.com",
  fullName: "Acme/Payments",
  url: "https://github.com/Acme/Payments",
  identity: "https://github.com/acme/payments",
  branch: "main",
  latest: null,
};

const parseAmount: ImpactSymbol = {
  name: "parseAmount",
  kind: "function",
  path: "src/money/parse.ts",
  startLine: 12,
  endLine: 38,
  change: "body",
  lines: [[31, 33]],
  uses: [
    {
      path: "src/refund/limits.ts",
      line: 27,
      within: "refundCap",
      code: "  if (parseAmount(input) > MAX_REFUND) {",
    },
    { path: "src/api/quotes.ts", line: 88, within: "createQuote", code: null },
  ],
  useCount: 2,
  fileCount: 2,
};
const formatAmount: ImpactSymbol = {
  ...parseAmount,
  name: "formatAmount",
  path: "src/money/format.ts",
  startLine: 5,
  endLine: 19,
  change: "signature",
  lines: [[5, 5]],
  uses: [],
  useCount: 0,
  fileCount: 0,
};

const view = (over: Partial<ImpactView> = {}): ImpactView => ({
  pull: { base: BASE, head: "c".repeat(40), files: 6, truncated: false, unread: 0 },
  graph: { commit: BASE, current: true, truncated: false, files: 1284 },
  build: null,
  symbols: [formatAmount, parseAmount],
  more: 0,
  ...over,
});

const finding = (over: Record<string, unknown>) => ({
  fingerprint: "f",
  reviewer: "correctness",
  category: null,
  verification: null,
  lineEnd: null,
  body: "",
  suggestion: null,
  code: null,
  redacted: false,
  truncated: false,
  ...over,
});

const detail = (pr: boolean) => ({
  review: {
    id: "r1",
    runId: "run",
    repo: "abcd1234",
    source: "github",
    verdict: "request_changes",
    complete: true,
    critical: 1,
    warning: 0,
    suggestion: 0,
    createdAt: new Date().toISOString(),
    prRepository: pr ? "https://github.com/acme/payments" : null,
    prNumber: pr ? 482 : null,
  },
  findings: [
    finding({
      id: "f1",
      severity: "critical",
      file: "src/money/parse.ts",
      lineStart: 31,
      title: "parseAmount now returns cents",
      body: "refundCap still compares it to a dollar limit.",
    }),
    finding({ id: "f2", severity: "warning", file: "README.md", lineStart: 3, title: "Typo" }),
  ],
});

function fakeApi(answers: Record<string, unknown>) {
  const fetch = vi.fn(async (url: string) => {
    if (url in answers) return Response.json(answers[url]);
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const answers = (impact: ImpactView, repos = [repo]) => ({
  "/api/reviews/r1": detail(true),
  "/api/graphs/repos": { repos },
  "/api/graphs/repos/g1/impact?pull=482": impact,
});

describe("the impact rail", () => {
  it("shows the whole pull request, then narrows to a finding's uses and marks the one it names", async () => {
    fakeApi(answers(view()));
    render(<ReviewDetail id="r1" graphs />);
    const rail = await screen.findByRole("complementary", { name: "Impact" });
    await within(rail).findByText("formatAmount");
    expect(within(rail).getByText(/of the whole pull request/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reaches 2 uses of parseAmount" }));
    expect(within(rail).queryByText("formatAmount")).toBeNull();
    expect(within(rail).getByText("named in the finding")).toBeTruthy();
    const use = within(rail).getByRole("link", { name: /src\/refund\/limits.ts:27/ });
    expect(use.getAttribute("href")).toBe(
      `https://github.com/Acme/Payments/blob/${BASE}/src/refund/limits.ts#L27`,
    );
    expect(
      within(rail).getByText("if (parseAmount(input) > MAX_REFUND) {", { exact: false }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reaches .* of/, pressed: false })).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    await within(rail).findByText("formatAmount");
  });

  it("says when the graph is behind the base or cut short", async () => {
    fakeApi(
      answers(
        view({ graph: { commit: "d".repeat(40), current: false, truncated: true, files: 9 } }),
      ),
    );
    render(<ReviewDetail id="r1" graphs />);
    await screen.findByText(/The graph is of ddddddd, not the pull request's base/);
    expect(screen.getByText(/cut this repository's file list short/)).toBeTruthy();
  });

  it("says a first build is running, with no uses yet", async () => {
    fakeApi(
      answers(
        view({ graph: null, symbols: [], build: { state: "running", commit: BASE, error: null } }),
      ),
    );
    render(<ReviewDetail id="r1" graphs />);
    await screen.findByText(/Building the graph of bbbbbbb/);
  });

  it("offers to keep a graph of a repository without one", async () => {
    fakeApi(answers(view(), []));
    render(<ReviewDetail id="r1" graphs />);
    await screen.findByRole("link", { name: "Keep a code graph" });
  });

  it("is not drawn for a review of no pull request, or where the server keeps no graphs", async () => {
    const fetch = fakeApi({ "/api/reviews/r1": detail(false) });
    render(<ReviewDetail id="r1" graphs />);
    await screen.findByText("parseAmount now returns cents");
    expect(screen.queryByRole("complementary", { name: "Impact" })).toBeNull();
    cleanup();
    await clearCache();
    fakeApi(answers(view()));
    render(<ReviewDetail id="r1" graphs={false} />);
    await screen.findByText("parseAmount now returns cents");
    expect(screen.queryByRole("complementary", { name: "Impact" })).toBeNull();
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain("/api/graphs/repos");
  });
});

describe("the rail's rules", () => {
  it("find a pull request's graph by its normalised repository, whatever the case", () => {
    expect(graphRepoOf([repo], "https://github.com/Acme/Payments")?.id).toBe("g1");
    expect(graphRepoOf([repo], "https://gitlab.com/acme/payments")).toBeUndefined();
  });

  it("place a finding in the symbols whose changed lines hold its line, in its file", () => {
    const symbols = [formatAmount, parseAmount];
    expect(symbolsOf(symbols, { file: "src/money/parse.ts", lineStart: 32 })).toEqual([
      parseAmount,
    ]);
    expect(symbolsOf(symbols, { file: "src/money/parse.ts", lineStart: 40 })).toEqual([]);
    expect(symbolsOf(symbols, { file: "src/money/format.ts", lineStart: null })).toEqual([
      formatAmount,
    ]);
  });

  it("link a GitLab use to its blob at the graph's commit", () => {
    expect(
      lineUrl(
        {
          ...repo,
          platform: "gitlab",
          host: "example.com:8443",
          fullName: "g/sub/api",
          url: "https://example.com:8443/gitlab/g/sub/api",
        },
        BASE,
        "a b.ts",
        4,
      ),
    ).toBe(`https://example.com:8443/gitlab/g/sub/api/-/blob/${BASE}/a%20b.ts#L4`);
  });
});
