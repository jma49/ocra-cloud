import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoReview } from "./pages/AutoReview.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REPO = {
  id: "rr1",
  platform: "gitlab",
  host: "gitlab.example.com",
  fullName: "pay/api",
  profile: "balanced",
  latest: {
    number: 9,
    head: "a".repeat(40),
    state: "failed",
    error: "clone failed",
    finishedAt: null,
  },
};

describe("the auto review page", () => {
  it("adds a repository and shows its hook's secret once", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          sent.push({ url, body: JSON.parse(String(init.body)) });
          return Response.json({
            repo: { ...REPO, latest: null },
            webhook: {
              url: "https://ocra.example.com/api/auto-review/webhooks/gitlab",
              secret: "ocra_hook_s3cret",
            },
          });
        }
        return Response.json({ repos: [REPO] });
      }),
    );
    render(<AutoReview />);
    expect(await screen.findByText("clone failed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "#9" }).getAttribute("href")).toBe(
      "/pull/gitlab/pay%2Fapi/9",
    );
    fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "gitlab" } });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: " pay/api " } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(sent).toEqual([
      { url: "/api/auto-review/repos", body: { platform: "gitlab", fullName: "pay/api" } },
    ]);
    expect((screen.getByLabelText("Secret token") as HTMLInputElement).value).toBe(
      "ocra_hook_s3cret",
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("Secret token")).toBeNull();
  });

  it("sets a repository's review profile", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          sent.push({ url, body: JSON.parse(String(init.body)) });
          return Response.json({ profile: "quiet" });
        }
        return Response.json({ repos: [REPO] });
      }),
    );
    render(<AutoReview />);
    const select = (await screen.findByLabelText("Review profile of pay/api")) as HTMLSelectElement;
    expect(select.value).toBe("balanced");
    await act(async () => void fireEvent.change(select, { target: { value: "quiet" } }));
    expect(sent).toEqual([
      { url: "/api/auto-review/repos/rr1/profile", body: { profile: "quiet" } },
    ]);
    expect(select.value).toBe("quiet");
  });
});
