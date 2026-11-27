import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Findings } from "./pages/Findings.js";
import { ToastProvider } from "./toast.js";
import { forgetProviders } from "./ui.js";

afterEach(() => {
  forgetProviders();
  cleanup();
  vi.unstubAllGlobals();
});

const row = {
  id: "f1",
  reviewId: "r1",
  repoHash: "h",
  repo: "h",
  name: "octo/api",
  prNumber: 12,
  reviewer: "correctness",
  severity: "warning",
  category: "correctness",
  verification: "verified",
  file: "src/app.ts",
  lineStart: 4,
  lineEnd: 4,
  title: "Retry count can go negative",
  status: "open",
  reason: null,
  note: null,
  decidedAt: null,
  thumbsUp: 0,
  thumbsDown: 0,
  rule: null,
  createdAt: "2026-11-23T00:00:00.000Z",
};

function pendingResponse() {
  let send!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    send = resolve;
  });
  return { promise, send };
}

describe("the findings list", () => {
  it.each(["accepted", "refused"] as const)(
    "keeps the %s decision's result on a revisit even if a pre-edit read finishes late",
    async (outcome) => {
      const page = (finding = row, fixed = 0) =>
        Response.json({
          findings: [finding],
          next: null,
          statuses: { open: 1, fixed, dismissed: 0, addressed: 0, merged: 0 },
        });
      const late = pendingResponse();
      const decision = pendingResponse();
      const revisit = pendingResponse();
      const read = vi
        .fn(() => revisit.promise)
        .mockResolvedValueOnce(page())
        .mockReturnValueOnce(late.promise);
      const accepted = outcome === "accepted";
      const confirmed = "Another open finding";
      if (accepted) read.mockResolvedValueOnce(page({ ...row, id: "f2", title: confirmed }, 1));
      const write = vi.fn((_body: unknown) => decision.promise);
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        if (url === "/api/findings?status=open" && (init.method ?? "GET") === "GET") return read();
        if (url === "/api/findings/decide" && init.method === "POST") {
          return write(JSON.parse(String(init.body)));
        }
        throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
      });

      const first = render(<Findings />);
      await screen.findByText(row.title);
      first.unmount();
      const editing = render(<Findings />);
      fireEvent.click(screen.getByLabelText(`Select ${row.title}`));
      fireEvent.click(screen.getByRole("button", { name: "Mark fixed" }));
      expect(write).toHaveBeenCalledWith({ ids: [row.id], status: "fixed" });
      expect(screen.getByText("No open findings")).toBeTruthy();

      await act(async () =>
        decision.send(
          accepted
            ? Response.json({ changed: 1, remembered: 0 })
            : Response.json({ error: "internal" }, { status: 500 }),
        ),
      );
      const settled = accepted ? confirmed : row.title;
      expect(screen.getByText(settled)).toBeTruthy();
      await act(async () => late.send(page({ ...row, title: "Pre-edit response" })));
      expect(screen.getByText(settled)).toBeTruthy();
      editing.unmount();

      render(<Findings />);
      expect(screen.getByText(settled)).toBeTruthy();
      expect(screen.getByText(accepted ? "Fixed (1)" : "Fixed (0)")).toBeTruthy();
      await act(async () => revisit.send(page({ ...row, title: "Read on revisit" })));
      expect(screen.getByText("Read on revisit")).toBeTruthy();
    },
  );

  it("names a category the reviewer is named after once, and the pull request it came from", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          findings: [row, { ...row, id: "f2", prNumber: null, category: "security" }],
          next: null,
          statuses: { open: 2, fixed: 0, dismissed: 0 },
        }),
      ),
    );
    render(
      <ToastProvider>
        <Findings />
      </ToastProvider>,
    );
    const [first, second] = await screen.findAllByRole("row").then((rows) => rows.slice(1));
    expect(first?.textContent).toContain("src/app.ts:4 · correctness · verified");
    expect(first?.textContent).toContain("octo/api #12");
    expect(second?.textContent).toContain("correctness · security · verified");
    expect(second?.textContent).not.toContain("#");
  });

  it("shows the thumbs a finding's comment got, and nothing without any", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          findings: [
            { ...row, thumbsUp: 3, thumbsDown: 1 },
            { ...row, id: "f2" },
          ],
          next: null,
          statuses: { open: 2, fixed: 0, dismissed: 0 },
        }),
      ),
    );
    render(
      <ToastProvider>
        <Findings />
      </ToastProvider>,
    );
    expect(await screen.findByRole("img", { name: "Reactions: 3 thumbs up, 1 thumbs down" }));
    expect(screen.getAllByRole("img", { name: /^Reactions/ })).toHaveLength(1);
  });

  it("says where each finding stands in the page's words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          findings: [
            { ...row, status: "merged" },
            { ...row, id: "f2", status: "addressed" },
          ],
          next: null,
          statuses: { open: 0, fixed: 0, dismissed: 0, addressed: 1, merged: 1 },
        }),
      ),
    );
    render(
      <ToastProvider>
        <Findings />
      </ToastProvider>,
    );
    const [first, second] = await screen.findAllByRole("row").then((rows) => rows.slice(1));
    expect(first?.querySelector(".status-warn")?.textContent).toBe("Merged unaddressed");
    expect(second?.querySelector(".status-quiet")?.textContent).toBe("Addressed");
    expect(screen.getByText("Merged unaddressed (1)")).toBeTruthy();
  });

  it("names a finding's rule, and filters by the rules listed or by none named", async () => {
    const fetch = vi.fn(async (_url: string) =>
      Response.json({
        findings: [{ ...row, rule: { kind: "learning", id: "retry-on-409" } }],
        next: null,
        statuses: { open: 1, fixed: 0, dismissed: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <ToastProvider>
        <Findings />
      </ToastProvider>,
    );
    const [first] = await screen.findAllByRole("row").then((rows) => rows.slice(1));
    expect(first?.textContent).toContain("verified · learning retry-on-409");
    const select = screen.getByLabelText("Rule");
    fireEvent.change(select, { target: { value: "learning:retry-on-409" } });
    await vi.waitFor(() =>
      expect(fetch.mock.calls.map(([u]) => u)).toContain(
        "/api/findings?status=open&rule=learning%3Aretry-on-409",
      ),
    );
    fireEvent.change(select, { target: { value: "none" } });
    await vi.waitFor(() =>
      expect(fetch.mock.calls.map(([u]) => u)).toContain("/api/findings?status=open&rule=none"),
    );
  });

  it("offers to clear filters that hide an account's findings, not to set up reviews", async () => {
    const fetch = vi.fn(async (_url: string) =>
      Response.json({
        findings: [],
        next: null,
        statuses: { open: 0, fixed: 2, dismissed: 0, addressed: 0, merged: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <ToastProvider>
        <Findings runner />
      </ToastProvider>,
    );
    expect(await screen.findByText("No open findings")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Set up auto review" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "critical" } });
    expect(await screen.findByText("No finding matches these filters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await vi.waitFor(() => expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/findings?status=open"));

    fireEvent.click(await screen.findByRole("button", { name: "Show all findings" }));
    await vi.waitFor(() => expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/findings"));
  });

  it("guides an account with no findings at all to set up reviews", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          findings: [],
          next: null,
          statuses: { open: 0, fixed: 0, dismissed: 0, addressed: 0, merged: 0 },
        }),
      ),
    );
    render(
      <ToastProvider>
        <Findings runner />
      </ToastProvider>,
    );
    expect(await screen.findByRole("link", { name: "Set up auto review" })).toBeTruthy();
    expect(screen.queryByText("Clear filters")).toBeNull();
  });
});
