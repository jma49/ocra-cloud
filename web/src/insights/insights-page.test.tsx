import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { Insights } from "../pages/Insights.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

describe("Insights", () => {
  const show = (runner: boolean, platforms: ("github" | "gitlab")[] = ["github"]) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "internal" }, { status: 500 })),
    );
    render(<Insights runner={runner} platforms={platforms} />);
  };

  it("leaves out the review flow and workload where the server reviews no repository itself", async () => {
    show(false);
    expect(await screen.findByRole("region", { name: "Pull request cycle" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Review flow" })).toBeNull();
  });

  it("shows them where it does", async () => {
    show(true);
    expect(await screen.findByRole("region", { name: "Review flow" })).toBeTruthy();
  });

  it("offers the cycle's platforms only where the server has more than one", async () => {
    show(false);
    const cycle = await screen.findByRole("region", { name: "Pull request cycle" });
    expect(within(cycle).queryByRole("group", { name: "Platform" })).toBeNull();
    cleanup();
    show(false, ["github", "gitlab"]);
    const both = await screen.findByRole("region", { name: "Pull request cycle" });
    expect(within(both).getByRole("group", { name: "Platform" })).toBeTruthy();
  });
});
