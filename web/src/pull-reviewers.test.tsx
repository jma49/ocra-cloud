import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullReviewersView } from "../../src/shared/index.js";
import { ReviewersPanel } from "./pull/reviewers.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view: PullReviewersView = {
  platform: "github",
  repo: "octo/api",
  number: 7,
  suggestions: [
    {
      login: "lead",
      reasons: ["codeowner"],
      score: 10,
      ownedFiles: 1,
      recentReviews: 0,
      load: 1,
      alreadyRequested: true,
    },
    {
      login: "dba",
      reasons: ["codeowner", "recent_reviewer"],
      score: 7,
      ownedFiles: 2,
      recentReviews: 1,
      load: 7,
      alreadyRequested: false,
    },
  ],
  owners: [{ owner: "octo/core", kind: "team", files: 1 }],
  codeowners: { path: "CODEOWNERS", read: true },
  history: "repository",
  historyDays: 90,
  truncated: false,
};

describe("suggested reviewers", () => {
  it("lists each with why and their load, and asks one for a review", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          sent.push(JSON.parse(String(init.body)));
          return Response.json({ outcome: "refused" });
        }
        return Response.json(view);
      }),
    );
    render(<ReviewersPanel pull={{ platform: "github", repo: "octo/api", number: 7 }} />);
    expect(
      await screen.findByText("owns 2 changed files · 1 review in 90 days · 7 open requests"),
    ).toBeTruthy();
    expect(screen.getByText("owns 1 changed file · 1 open request")).toBeTruthy();
    expect(screen.getByText("Asked")).toBeTruthy();
    expect(screen.getByText("Also owned by octo/core.")).toBeTruthy();
    await act(
      async () =>
        void fireEvent.click(screen.getByRole("button", { name: "Ask dba for a review" })),
    );
    expect(sent).toEqual([{ platform: "github", repo: "octo/api", number: 7, logins: ["dba"] }]);
    expect((await screen.findByRole("alert")).textContent).toMatch(/refused/);
  });
});
