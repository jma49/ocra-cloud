import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphRepoView, ImpactView } from "../../../src/shared/index.js";
import { clearCache } from "../cache.js";
import { CodeGraph } from "./CodeGraph.js";

const COMMIT = "b".repeat(40);

const repo: GraphRepoView = {
  id: "g1",
  platform: "github",
  host: "github.com",
  fullName: "octo/api",
  url: "https://github.com/octo/api",
  identity: "https://github.com/octo/api",
  branch: "main",
  latest: {
    commit: COMMIT,
    state: "done",
    files: 3,
    bytes: 900,
    truncated: false,
    error: null,
    finishedAt: new Date().toISOString(),
  },
};

const stored = {
  format: 1,
  parser: "test",
  files: [
    ["src/api/routes.ts", "k1"],
    ["src/billing/charge.ts", "k2"],
    ["src/util/log.ts", "k3"],
  ],
  symbols: [
    [
      "k1",
      {
        definitions: [["handle", "function", 3, 20]],
        uses: [
          ["chargeCard", [8, 12]],
          ["logLine", [15]],
        ],
      },
    ],
    [
      "k2",
      {
        definitions: [["chargeCard", "function", 1, 30]],
        uses: [
          ["chargeCard", [1]],
          ["logLine", [20]],
        ],
      },
    ],
    ["k3", { definitions: [["logLine", "function", 1, 4]], uses: [["logLine", [1]]] }],
  ],
};

const impact: ImpactView = {
  pull: { base: "a".repeat(40), head: "c".repeat(40), files: 1, truncated: false, unread: 0 },
  graph: { commit: COMMIT, current: true, truncated: false, files: 3 },
  build: null,
  symbols: [
    {
      name: "chargeCard",
      kind: "function",
      path: "src/billing/charge.ts",
      startLine: 1,
      endLine: 30,
      change: "signature",
      lines: [[1, 2]],
      uses: [{ path: "src/api/routes.ts", line: 8, within: "handle", code: null }],
      useCount: 1,
      fileCount: 1,
    },
  ],
  more: 0,
};

function fakeApi(graph: { status: number; body?: unknown } = { status: 200, body: stored }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/graphs/repos") return Response.json({ repos: [repo] });
      if (url === "/api/graphs/repos/g1/graph") {
        return new Response(JSON.stringify(graph.body ?? { error: "not_found" }), {
          status: graph.status,
          headers: { "x-ocra-graph-commit": COMMIT },
        });
      }
      if (url === "/api/graphs/repos/g1/impact?pull=7") return Response.json(impact);
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
}

const at = (search: string) => history.replaceState(null, "", `/code-graphs/g1${search}`);

beforeEach(() => at(""));
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const details = () => within(screen.getByRole("complementary", { name: "Details" }));
const shown = async () => within(await screen.findByRole("complementary", { name: "Details" }));

describe("the code graph explorer", () => {
  it("opens on the map of the repository's one top folder and goes into a part", async () => {
    fakeApi();
    render(<CodeGraph id="g1" />);
    expect(await screen.findByText(/3 files · 3 symbols/)).toBeTruthy();
    const rows = (await shown()).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("api"),
      expect.stringContaining("billing"),
      expect.stringContaining("util"),
    ]);
    expect(screen.getByRole("img", { name: /Map of src: 3 parts/ })).toBeTruthy();

    fireEvent.click(rows[1] as HTMLElement);
    expect(location.search).toBe("?in=src%2Fbilling");
    fireEvent.click(await details().findByRole("button", { name: /charge\.ts/ }));
    expect(location.search).toBe("?file=src%2Fbilling%2Fcharge.ts");
    expect(await screen.findByText("Used by · 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "src/api/routes.ts" })).toBeTruthy();
  });

  it("shows a symbol's callers and links each use to the platform at the graph's commit", async () => {
    at("?file=src%2Fbilling%2Fcharge.ts&symbol=chargeCard&line=1");
    fakeApi();
    render(<CodeGraph id="g1" />);
    expect(
      await screen.findByRole("button", { name: /handle, function in src\/api\/routes\.ts/ }),
    ).toBeTruthy();
    const uses = details().getAllByRole("link");
    expect(uses.map((a) => a.getAttribute("href"))).toEqual(
      expect.arrayContaining([
        `https://github.com/octo/api/blob/${COMMIT}/src/api/routes.ts#L8`,
        `https://github.com/octo/api/blob/${COMMIT}/src/api/routes.ts#L12`,
      ]),
    );
    expect(details().getAllByText("in handle")).toHaveLength(2);
  });

  it("finds a symbol by name and focuses it", async () => {
    fakeApi();
    render(<CodeGraph id="g1" />);
    const field = await screen.findByRole("combobox", { name: "Find a file or symbol" });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "logline" } });
    const [first] = await screen.findAllByRole("option", { name: /logLine/ });
    expect(first?.textContent).toMatch(/^logLine.*src\/util\/log\.ts:1/);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(location.search).toBe("?file=src%2Futil%2Flog.ts&symbol=logLine&line=1");
  });

  it("draws a pull request's changed symbols beside what uses them", async () => {
    at("?pull=7");
    fakeApi();
    render(<CodeGraph id="g1" />);
    const changed = await screen.findByRole("button", { name: "chargeCard, signature changed" });
    expect(screen.getByRole("button", { name: "handle in src/api/routes.ts" })).toBeTruthy();
    fireEvent.click(changed);
    expect(location.search).toBe("?file=src%2Fbilling%2Fcharge.ts&symbol=chargeCard&line=1");
  });

  it("says when no graph is built yet", async () => {
    fakeApi({ status: 404 });
    render(<CodeGraph id="g1" />);
    expect(await screen.findByText("No graph built yet")).toBeTruthy();
  });

  it("says when the repository is not kept", async () => {
    fakeApi();
    render(<CodeGraph id="gone" />);
    expect(await screen.findByText("This code graph is not kept")).toBeTruthy();
  });
});
