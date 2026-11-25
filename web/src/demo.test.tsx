import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_SCENARIOS } from "./demo/scenarios.js";
import { emptyProgress, fold } from "./live/fold.js";
import { Demo } from "./pages/Demo.js";

afterEach(cleanup);

describe("demo scenarios", () => {
  it("fold cleanly to their expected finished verdict", () => {
    for (const scenario of DEMO_SCENARIOS) {
      const progress = fold(emptyProgress(), scenario.events);
      expect(progress.ending?.kind).toBe("finished");
      expect(progress.costUsd).toBeGreaterThan(0);
    }
    const clean = DEMO_SCENARIOS.find((s) => s.id === "clean-refactor");
    expect(clean).toBeDefined();
    if (clean) {
      const p = fold(emptyProgress(), clean.events);
      expect(p.findings.size).toBe(0);
      expect(p.ending?.kind === "finished" && p.ending.verdict).toBe("approved");
    }
  });
});

describe("Demo page", () => {
  it("replays, skips to the final finding, and switches scenarios", () => {
    render(<Demo />);
    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));
    expect(screen.getByText("Every session is treated as expired")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Quiet pass/i }));
    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));
    expect(screen.getByText("No findings")).toBeTruthy();
  });
});
