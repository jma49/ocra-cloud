import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetKeys } from "../account-keys.js";
import type { Me } from "../api.js";
import { clearCache } from "../cache.js";
import { Overview } from "./Overview.js";

afterEach(async () => {
  forgetKeys();
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const session = (kind: "web" | "cli") => ({
  id: kind,
  kind,
  label: null,
  createdAt: "2026-11-20T10:00:00Z",
  lastUsedAt: null,
  expiresAt: "2026-12-20T10:00:00Z",
});

function fakeApi(state: { keys: number; cli: boolean; reviews: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input);
      if (path.endsWith("/api/providers")) return Response.json({ providers: [] });
      if (path.endsWith("/api/keys"))
        return Response.json({
          keys: Array.from({ length: state.keys }, (_, i) => ({ provider: `p${i}` })),
        });
      if (path.endsWith("/api/sessions"))
        return Response.json({
          sessions: [session("web"), ...(state.cli ? [session("cli")] : [])],
        });
      if (path.endsWith("/api/auto-review/repos"))
        return Response.json({ error: "not_found" }, { status: 404 });
      if (path.endsWith("/api/platforms/repos")) return Response.json({ platforms: [] });
      if (path.includes("/api/reviews"))
        return Response.json({ summary: { reviews: state.reviews } });
      return Response.json({ days: 14, today: 0, dailyLimit: 500, series: [] });
    }),
  );
}

const ME: Me = {
  login: "ada",
  githubId: 1,
  githubUrl: "https://github.com",
  avatarUrl: null,
  session: "web",
  since: "",
  codeGraphs: "off",
  autoReview: false,
  platforms: ["github"],
};

const step = (title: string) => screen.getByText(title).closest(".step");

describe("getting started", () => {
  it("ticks signing in from the terminal and reviewing once the account has done them", async () => {
    fakeApi({ keys: 0, cli: true, reviews: 2 });
    render(<Overview me={ME} />);
    await waitFor(() => expect(step("Review a change")?.classList.contains("done")).toBe(true));
    expect(step("Install the CLI and sign in")?.classList.contains("done")).toBe(true);
    expect(step("Add a provider key")?.classList.contains("done")).toBe(false);
  });

  it("goes away once every step is done", async () => {
    fakeApi({ keys: 1, cli: true, reviews: 1 });
    render(<Overview me={ME} />);
    await waitFor(() => expect(screen.queryByText("Set up reviews")).toBeNull());
  });
});
