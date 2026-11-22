import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { Insights } from "../pages/Insights.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

describe("Insights", () => {
  const show = (runner: boolean) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "internal" }, { status: 500 })),
    );
    render(<Insights runner={runner} />);
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
});
