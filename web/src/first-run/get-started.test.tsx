import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetKeys } from "../account-keys.js";
import type { Me } from "../api.js";
import { NoKeyNotice } from "../auto-review/no-key.js";
import { clearCache } from "../cache.js";
import { GetStarted } from "./get-started.js";

const me: Me = {
  login: "new-user",
  githubId: 1,
  githubUrl: "https://github.com",
  avatarUrl: null,
  session: "web",
  since: "",
  codeGraphs: "off",
  autoReview: true,
  platforms: ["github"],
};
const summary = (reviews: number) => ({
  summary: { reviews },
  reviews: [],
  reviewers: {},
  days: 90,
});

function serve(o: { keys?: number; enrolled?: number; reviews?: number; repos?: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input).replace(/^\/api/, "");
      if (path === "/platforms/repos")
        return Response.json({
          sharing: false,
          platforms: [
            {
              platform: "github",
              host: "github.com",
              linked: true,
              failed: false,
              more: false,
              installUrl: "https://github.com/apps/ocra-cloud/installations/new",
              repositories: Array.from({ length: o.repos ?? 0 }, (_, i) => ({ id: String(i) })),
            },
          ],
        });
      if (path === "/keys") return Response.json({ keys: Array(o.keys ?? 0).fill({}) });
      if (path === "/auto-review/repos")
        return Response.json({ repos: Array(o.enrolled ?? 0).fill({}) });
      if (path === "/sessions") return Response.json({ sessions: [] });
      if (path.startsWith("/reviews")) return Response.json(summary(o.reviews ?? 0));
      return Response.json({}, { status: 404 });
    }),
  );
}

beforeEach(async () => {
  await clearCache();
  localStorage.clear();
});
afterEach(() => {
  forgetKeys();
  cleanup();
  vi.unstubAllGlobals();
});

describe("Set up reviews", () => {
  it("offers only the step to do now, with its one action", async () => {
    serve({ repos: 2 });
    render(<GetStarted me={me} hideable />);
    expect(await screen.findByText("2 of 5 done")).toBeTruthy();
    const current = screen.getByRole("listitem", { current: "step" });
    expect(current.textContent).toContain("Add a provider key");
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["Add a key"]);
  });

  it("reads the repositories again on coming back from installing the app", async () => {
    serve({ keys: 1 });
    render(<GetStarted me={me} />);
    const choose = await screen.findByRole("link", { name: "Choose repositories" });
    choose.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(choose);
    serve({ keys: 1, repos: 1 });
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(await screen.findByText("Set up auto review")).toBeTruthy();
  });

  it("is gone once the first review is in", async () => {
    serve({ repos: 1, keys: 1, enrolled: 1, reviews: 1 });
    const { container } = render(<GetStarted me={me} hideable />);
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(5));
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe("");
  });

  it("stays hidden for this account once hidden", async () => {
    serve({});
    render(<GetStarted me={me} hideable />);
    fireEvent.click(await screen.findByRole("button", { name: "Hide setup" }));
    expect(screen.queryByText("Set up reviews")).toBeNull();
    cleanup();
    render(<GetStarted me={me} hideable />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Set up reviews")).toBeNull();
  });
});

describe("Auto review without a key", () => {
  it("says reviews would fail and links to adding one", async () => {
    serve({ keys: 0 });
    render(<NoKeyNotice />);
    expect((await screen.findByRole("status")).textContent).toMatch(/you have none yet/);
    expect(screen.getByRole("link", { name: "Add a key" }).getAttribute("href")).toBe("/keys");
  });
});
