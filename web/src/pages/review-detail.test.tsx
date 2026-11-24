import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { ReviewDetail } from "./ReviewDetail.js";
import { PlatformThread } from "./review-finding.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const review = (learnings: string[] | null) => ({
  review: {
    id: "r1",
    runId: "run",
    repo: "abcd1234",
    source: "local",
    verdict: "approved_with_comments",
    complete: true,
    critical: 0,
    warning: 0,
    suggestion: 0,
    createdAt: new Date().toISOString(),
    prRepository: null,
    prNumber: null,
    learnings,
  },
  findings: [],
  walkthrough: null,
});

function serve(learnings: string[] | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/reviews/r1"
        ? Response.json(review(learnings))
        : Response.json({ error: "not_found" }, { status: 404 }),
    ),
  );
}

describe("a review's properties", () => {
  it("name the learnings its reviewers were given", async () => {
    serve(["refund-cap", "ledger-order"]);
    render(<ReviewDetail id="r1" graphs={false} />);
    const props = await screen.findByRole("complementary", { name: "Properties" });
    expect(within(props).getByText("Learnings")).toBeTruthy();
    expect(within(props).getByText("refund-cap")).toBeTruthy();
    expect(within(props).getByText("ledger-order")).toBeTruthy();
  });

  it("leave learnings out when the review was given none", async () => {
    serve([]);
    render(<ReviewDetail id="r1" graphs={false} />);
    const props = await screen.findByRole("complementary", { name: "Properties" });
    expect(within(props).queryByText("Learnings")).toBeNull();
    expect(within(props).getByText("Approved with comments")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Review of abcd1234");
  });
});

describe("a finding's fix on its review", () => {
  const finding = {
    id: "f1",
    fingerprint: "fp",
    reviewer: "correctness",
    severity: "critical",
    category: null,
    verification: "confirmed",
    file: "src/refund.ts",
    lineStart: 11,
    lineEnd: 11,
    title: "Refund can exceed what was captured",
    body: "The check uses the charge's amount.",
    suggestion: null,
    code: "if (amount > charge.amount) {",
    redacted: false,
    truncated: false,
    evidence: ["`charge.amount` ignores earlier refunds", "No caller checks the sum"],
    status: "open",
    fix: { startLine: 11, endLine: 11, replacement: "if (amount > left) {\n" },
    issue: null,
  };
  const ofPull = {
    ...review([]),
    review: {
      ...review([]).review,
      source: "github",
      prRepository: "https://github.com/octo/api",
      prNumber: 7,
      prHeadSha: "a".repeat(40),
    },
    findings: [finding],
  };

  it("is titled by the pull request it reviewed, with the head under how it ran", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/reviews/r1"
          ? Response.json(ofPull)
          : Response.json({ error: "not_found" }, { status: 404 }),
      ),
    );
    render(<ReviewDetail id="r1" graphs={false} />);
    const title = await screen.findByRole("heading", { name: "Review of octo/api #7" });
    expect(title.parentElement?.textContent).toContain("GitHub PR · aaaaaaa");
  });

  it("folds the finding's evidence under its details, a fact a line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/reviews/r1"
          ? Response.json(ofPull)
          : Response.json({ error: "not_found" }, { status: 404 }),
      ),
    );
    const { container } = render(<ReviewDetail id="r1" graphs={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    const evidence = container.querySelector("details.evidence");
    expect(evidence?.hasAttribute("open")).toBe(false);
    expect(evidence?.querySelector("summary")?.textContent).toBe("Evidence");
    expect([...(evidence?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual([
      "charge.amount ignores earlier refunds",
      "No caller checks the sum",
    ]);
    expect(evidence?.querySelector("code")?.textContent).toBe("charge.amount");
  });

  it("shows as a diff of the lines it replaces at the reviewed head", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/reviews/r1") return Response.json(ofPull);
        if (url === "/api/pulls/fixes/review/r1") {
          return Response.json({
            review: { id: "r1", head: "a".repeat(40) },
            fixes: [
              {
                finding: "f1",
                title: finding.title,
                severity: "critical",
                file: finding.file,
                startLine: 11,
                endLine: 11,
                before: ["if (amount > charge.amount) {"],
                after: ["if (amount > left) {"],
              },
            ],
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      }),
    );
    render(<ReviewDetail id="r1" graphs={false} />);
    await screen.findByText("if (amount > charge.amount) {", { selector: "td", ignore: "pre" });
    const rows = screen.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toEqual(["11−if (amount > charge.amount) {", "11+if (amount > left) {"]);
    expect(screen.queryByText("if (amount > charge.amount) {", { selector: "pre" })).toBeNull();
    expect(screen.getByRole("button", { name: "Commit fix" })).toBeTruthy();
  });

  it("says where it stands: fixed, dismissed, or its thread resolved on the platform", async () => {
    const resolved = {
      state: "resolved",
      by: "rita",
      at: null,
      reason: null,
      reasonBy: null,
      reasonAt: null,
      redacted: false,
      truncated: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/reviews/r1"
          ? Response.json({
              ...ofPull,
              findings: [
                { ...finding, platformDismissal: resolved },
                { ...finding, id: "f2", title: "Second", status: "dismissed" },
              ],
            })
          : Response.json({ error: "not_found" }, { status: 404 }),
      ),
    );
    render(<ReviewDetail id="r1" graphs={false} />);
    expect(await screen.findByText("Thread resolved by rita")).toBeTruthy();
    expect(screen.getByText("Dismissed")).toBeTruthy();
  });

  it("names the lines it replaces, beside the quoted code, when they could not be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/reviews/r1"
          ? Response.json(ofPull)
          : Response.json({ error: "upstream_unreachable" }, { status: 502 }),
      ),
    );
    render(<ReviewDetail id="r1" graphs={false} />);
    expect(await screen.findByText("Replaces line 11")).toBeTruthy();
    expect(screen.getByText("if (amount > charge.amount) {", { selector: "pre" })).toBeTruthy();
    expect(screen.getByText("if (amount > left) {")).toBeTruthy();
  });
});

describe("what happened to a finding's thread on the platform", () => {
  const none = {
    state: null,
    by: null,
    at: null,
    reason: null,
    reasonBy: null,
    reasonAt: null,
    redacted: false,
    truncated: false,
  };

  const lines = (d: Parameters<typeof PlatformThread>[0]["d"]) => {
    cleanup();
    const { container } = render(<PlatformThread d={d} />);
    return Array.from(container.querySelectorAll("p"), (p) => p.textContent);
  };
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();

  it("says who resolved or reopened it and when, and the reply kept as the reason", () => {
    expect(lines({ ...none, state: "resolved", by: "rita", at: hourAgo })).toEqual([
      "Resolved by rita, 1h ago",
    ]);
    expect(lines({ ...none, state: "unresolved", reason: "By design.", reasonBy: "lena" })).toEqual(
      ["Reopened", "By design.", "lena"],
    );
    expect(lines({ ...none, reason: "By design." })).toEqual(["By design.", "A reply"]);
  });

  it("says when the server replaced a secret-looking string of the reply, or cut it", () => {
    expect(
      lines({ ...none, reason: "x", reasonBy: "lena", redacted: true, truncated: true }),
    ).toEqual(["x", "lena · a secret-looking string was replaced, cut short"]);
  });
});
