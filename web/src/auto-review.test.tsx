import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { offeredRepos } from "./auto-review/add-repo.js";
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

  it("offers a platform's listed repositories but the ones already under review", () => {
    const listed = {
      platforms: [
        {
          platform: "github" as const,
          repositories: [{ fullName: "acme/api" }, { fullName: "Acme/Web" }],
        },
        { platform: "gitlab" as const, repositories: [{ fullName: "pay/api" }] },
      ],
    };
    const enrolled = [{ ...REPO, platform: "github" as const, fullName: "ACME/api" }];
    expect(offeredRepos(listed, "github", enrolled)).toEqual(["Acme/Web"]);
    expect(offeredRepos(listed, "gitlab", enrolled)).toEqual(["pay/api"]);
    expect(offeredRepos(undefined, "github", [])).toEqual([]);
  });

  it("asks nothing more on GitHub for a repository the App already covers", async () => {
    const added = { ...REPO, id: "r2", platform: "github", fullName: "acme/web", latest: null };
    let repos: unknown[] = [{ ...REPO, platform: "github", fullName: "acme/api" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          repos = [...repos, added];
          return Response.json({
            repo: added,
            webhook: { url: "https://ocra.example.com/api/webhooks/github" },
          });
        }
        if (url.startsWith("/api/platforms/repos")) {
          return Response.json({
            platforms: [
              {
                platform: "github",
                repositories: [{ fullName: "acme/api" }, { fullName: "Acme/Web" }],
              },
            ],
          });
        }
        if (url.startsWith("/api/review-targets")) {
          return Response.json({ default: { firstReviewHours: null, mergeDays: null }, repos: [] });
        }
        return Response.json({ repos });
      }),
    );
    render(<AutoReview platforms={["github"]} />);
    await screen.findByText("acme/api");
    const field = screen.getByLabelText("Repository");
    fireEvent.change(field, { target: { value: "acme/web" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(await screen.findByText("acme/web")).toBeTruthy();
    expect(screen.queryByLabelText("Webhook")).toBeNull();
  });

  it("shows the one step on GitHub for a repository the App does not reach yet", async () => {
    const added = { ...REPO, id: "r2", platform: "github", fullName: "acme/web", latest: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Response.json({
            repo: added,
            webhook: { url: "https://ocra.example.com/api/webhooks/github" },
          });
        }
        if (url.startsWith("/api/platforms/repos")) {
          return Response.json({ platforms: [{ platform: "github", repositories: [] }] });
        }
        if (url.startsWith("/api/review-targets")) {
          return Response.json({ default: { firstReviewHours: null, mergeDays: null }, repos: [] });
        }
        return Response.json({ repos: [] });
      }),
    );
    render(<AutoReview platforms={["github"]} />);
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "acme/web" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(await screen.findByLabelText("Webhook")).toBeTruthy();
  });

  it("says the day's model calls are used and which review waits for the reset", async () => {
    const waiting = { ...REPO.latest, state: "queued", error: "daily_limit" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/budget")) {
          return Response.json({ serviceDailyCalls: 500, dailyCalls: null, callsToday: 500 });
        }
        if (url.startsWith("/api/review-targets")) {
          return Response.json({ default: { firstReviewHours: null, mergeDays: null }, repos: [] });
        }
        return Response.json({ repos: [{ ...REPO, latest: waiting }] });
      }),
    );
    render(<AutoReview platforms={["github"]} />);
    expect(await screen.findByText("Daily limit reached")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Budget" }).getAttribute("href")).toBe("/budget");
    expect(
      await screen.findByText(
        "The daily limit cut this review short. It runs again when the limit resets.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("daily_limit")).toBeNull();
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
