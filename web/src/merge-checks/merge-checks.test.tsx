import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChecksBox } from "../pull/checks-box.js";
import { RepoChecks } from "./repo-checks.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pull = { platform: "github", repo: "acme/payments", number: 482 };

describe("a repository's pre-merge checks", () => {
  it("adds a title check with the settings its kind takes, and changes a check's mode", async () => {
    const sent: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          sent.push({ url, method, body: JSON.parse(String(init?.body)) });
          return Response.json({ check: {} });
        }
        return Response.json({
          checks: [
            {
              id: "c1",
              kind: "size",
              mode: "warn",
              settings: { maxLines: 400 },
              createdAt: "2026-11-22T10:00:00Z",
            },
          ],
        });
      }),
    );
    render(<RepoChecks repoId="p1" fullName="acme/payments" />);
    expect(await screen.findByText("at most 400 lines")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Check"), { target: { value: "title" } });
    fireEvent.change(screen.getByLabelText("Prefixes"), { target: { value: "feat:, fix:" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(sent[0]).toEqual({
      url: "/api/merge-checks/repos/p1/checks",
      method: "POST",
      body: { kind: "title", mode: "block", settings: { prefixes: ["feat:", "fix:"] } },
    });
    await act(
      async () =>
        void fireEvent.change(screen.getByLabelText("Size mode"), { target: { value: "block" } }),
    );
    expect(sent[1]).toEqual({
      url: "/api/merge-checks/repos/p1/checks/c1",
      method: "PATCH",
      body: { mode: "block" },
    });
  });
});

describe("a pull request's checks", () => {
  const serve = (report: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ report, postedAt: null })),
    );

  it("says the merge is blocked, and which check blocks it", async () => {
    serve({
      head: "abc",
      conclusion: "failure",
      results: [
        {
          id: "c1",
          kind: "linked_issue",
          mode: "block",
          outcome: "failed",
          detail: "No linked issue.",
        },
        { id: "c2", kind: "size", mode: "warn", outcome: "passed", detail: "12 lines." },
      ],
    });
    render(<ChecksBox pull={pull} head="abc" />);
    expect(await screen.findByText("Blocked")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Failed, blocks" })).toBeTruthy();
    expect(screen.getByText("No linked issue.")).toBeTruthy();
  });

  it("shows nothing where the repository has no checks", async () => {
    serve(null);
    const { container } = render(<ChecksBox pull={pull} head="abc" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
