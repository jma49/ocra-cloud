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
  automatic: true,
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
        if (url.startsWith("/api/review-targets")) {
          return Response.json({ default: { firstReviewHours: null, mergeDays: null }, repos: [] });
        }
        return Response.json({ repos: [REPO] });
      }),
    );
    render(<AutoReview platforms={["github", "gitlab"]} />);
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
        if (url.startsWith("/api/review-targets")) {
          return Response.json({ default: { firstReviewHours: null, mergeDays: null }, repos: [] });
        }
        return Response.json({ repos: [REPO] });
      }),
    );
    render(<AutoReview platforms={["github", "gitlab"]} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Review profile of pay/api: Balanced" }),
    );
    const quiet = await screen.findByRole("menuitemradio", { name: /^Quiet/ });
    expect(quiet.textContent).toContain("on the changed lines only");
    expect(screen.getByRole("menuitemradio", { name: /^Thorough/ }).textContent).toContain(
      "About twice the cost",
    );
    await act(async () => void fireEvent.click(quiet));
    expect(sent).toEqual([
      { url: "/api/auto-review/repos/rr1/profile", body: { profile: "quiet" } },
    ]);
    expect(screen.getByRole("button", { name: "Review profile of pay/api: Quiet" })).toBeTruthy();
  });

  it("switches a repository's automatic reviews off, and back when the save fails", async () => {
    const sent: unknown[] = [];
    let refuse = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          sent.push({ url, body });
          return refuse
            ? Response.json({ error: "not_found" }, { status: 404 })
            : Response.json(body);
        }
        if (url.startsWith("/api/review-targets")) {
          return Response.json({ default: { firstReviewHours: null, mergeDays: null }, repos: [] });
        }
        return Response.json({ repos: [REPO] });
      }),
    );
    render(<AutoReview platforms={["github", "gitlab"]} />);
    const toggle = await screen.findByRole("switch", { name: "Review pay/api automatically" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Every pull request")).toBeTruthy();
    await act(async () => void fireEvent.click(toggle));
    expect(sent).toEqual([
      { url: "/api/auto-review/repos/rr1/automatic", body: { automatic: false } },
    ]);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Only when asked")).toBeTruthy();

    refuse = true;
    await act(async () => void fireEvent.click(toggle));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("says whether a remote runner is asking for work", async () => {
    const runners = [
      { name: "mini", version: "0.12.0", lastSeenAt: new Date().toISOString() },
      {
        name: "old",
        version: "0.11.0",
        lastSeenAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ];
    let listed = runners;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/auto-review/runners")
          ? Response.json({ remote: true, runners: listed })
          : url.startsWith("/api/review-targets")
            ? Response.json({ default: { firstReviewHours: null, mergeDays: null }, repos: [] })
            : Response.json({ repos: [] }),
      ),
    );
    const first = render(<AutoReview platforms={["github"]} />);
    const rows = (await screen.findAllByRole("listitem")).map((li) => li.textContent);
    expect(rows[0]).toContain("mini Online Asked for work just now · ocra 0.12.0");
    expect(rows[1]).toContain("old Offline Asked for work 1h ago");
    first.unmount();
    listed = [];
    render(<AutoReview platforms={["github"]} />);
    expect((await screen.findByRole("status")).textContent).toContain("No runner is connected");
  });
});
