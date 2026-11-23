import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { AtRiskSection } from "../insights/at-risk.js";
import { ReviewTargetsCard } from "./targets-card.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const repo = (id: string, fullName: string, targets: unknown = null) => ({
  reviewRepoId: id,
  platform: "github",
  fullName,
  targets,
});
const view = {
  default: { firstReviewHours: 24, mergeDays: null },
  repos: [repo("r1", "octo/api"), repo("r2", "octo/web", { firstReviewHours: 4, mergeDays: 2 })],
};

describe("the review targets card", () => {
  const show = () => {
    const sent: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method && init.method !== "GET") {
          sent.push({
            method: init.method,
            url,
            body: init.body ? JSON.parse(String(init.body)) : null,
          });
          return Response.json({ removed: true });
        }
        return Response.json(view);
      }),
    );
    render(<ReviewTargetsCard />);
    return sent;
  };

  it("saves the default, an empty field as no target", async () => {
    const sent = show();
    const hours = await screen.findByLabelText("Default: hours to the first review");
    expect((hours as HTMLInputElement).value).toBe("24");
    expect((screen.getByLabelText("Default: days to merge") as HTMLInputElement).value).toBe("");
    fireEvent.change(hours, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Default: days to merge"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent).toEqual([
        {
          method: "PUT",
          url: "/api/review-targets/default",
          body: { firstReviewHours: null, mergeDays: 5 },
        },
      ]),
    );
  });

  it("gives a repository its own targets, starting from the default", async () => {
    const sent = show();
    const row = (await screen.findByText("octo/api")).closest("li") as HTMLElement;
    expect(within(row).getByText("Default")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Set its own" }));
    const hours = within(row).getByLabelText("octo/api: hours to the first review");
    expect((hours as HTMLInputElement).value).toBe("24");
    fireEvent.change(hours, { target: { value: "8" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent).toEqual([
        {
          method: "PUT",
          url: "/api/review-targets/repos/r1",
          body: { firstReviewHours: 8, mergeDays: null },
        },
      ]),
    );
  });

  it("resets a repository to the default", async () => {
    const sent = show();
    const row = (await screen.findByText("octo/web")).closest("li") as HTMLElement;
    expect(within(row).getByText("Its own: first review in 4h, merged in 2d")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Use default" }));
    await waitFor(() =>
      expect(sent).toEqual([{ method: "DELETE", url: "/api/review-targets/repos/r2", body: null }]),
    );
  });
});

describe("the pull requests at risk", () => {
  const HOUR = 3_600_000;
  const pull = (number: number, state: string, dueIn: number, waitingOn: string[] = []) => ({
    platform: "github",
    repo: "octo/api",
    number,
    title: `Change ${number}`,
    author: "ada",
    target: number % 2 ? "first_review" : "merge",
    state,
    since: new Date(Date.now() - 30 * HOUR).toISOString(),
    due: new Date(Date.now() + dueIn * HOUR).toISOString(),
    waitingOn,
  });
  const show = (risk: (repo: string | null) => unknown) => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(url);
        if (url.startsWith("/api/review-targets")) return Response.json(view);
        return Response.json(risk(new URL(url, "http://x").searchParams.get("repo")));
      }),
    );
    render(<AtRiskSection />);
    return asked;
  };

  it("lists each one with its target, who it waits on and when it is due", async () => {
    show((repo) => ({
      repo,
      pulls: [pull(1, "past", -5, ["lena"]), pull(2, "near", 3)],
      targetsSet: true,
      capped: false,
    }));
    const past = (await screen.findByText("Change 1")).closest("tr") as HTMLElement;
    expect(within(past).getByText("Past")).toBeTruthy();
    expect(within(past).getByText("First review")).toBeTruthy();
    expect(within(past).getByText("lena")).toBeTruthy();
    expect(within(past).getByText("5h overdue")).toBeTruthy();
    expect(within(past).getByRole("link", { name: "Change 1" }).getAttribute("href")).toBe(
      "/pull/github/octo%2Fapi/1",
    );
    const near = screen.getByText("Change 2").closest("tr") as HTMLElement;
    expect(within(near).getByText("Near")).toBeTruthy();
    expect(within(near).getByText("Merge")).toBeTruthy();
    expect(within(near).getByText(/^due in (3|2\.9)h$/)).toBeTruthy();
  });

  it("asks for one repository when it is picked", async () => {
    const asked = show((repo) => ({ repo, pulls: [], targetsSet: true, capped: false }));
    expect(await screen.findByText(/No open pull request is near a target/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Repository at risk"), {
      target: { value: "octo/web" },
    });
    await waitFor(() => expect(asked).toContain("/api/insights/at-risk?repo=octo%2Fweb"));
  });

  it("leads to the targets when none is set", async () => {
    show((repo) => ({ repo, pulls: [], targetsSet: false, capped: false }));
    expect(await screen.findByText(/No review target is set/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set review targets" }).getAttribute("href")).toBe(
      "/auto-review",
    );
  });
});
