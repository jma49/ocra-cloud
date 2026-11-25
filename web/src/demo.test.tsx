import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_SCENARIOS } from "./demo/scenarios.js";
import { emptyProgress, fold } from "./live/fold.js";
import { Demo } from "./pages/Demo.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
  it("measures stage time from revealed events rather than the wall clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { container } = render(<Demo />);
    const stageTime = () => container.querySelector(".stage-now .elapsed")?.textContent;
    expect(stageTime()).toBeUndefined();

    for (const delay of [550, 500, 450, 450]) {
      act(() => void vi.advanceTimersByTime(delay));
    }
    expect(screen.getByText("Review", { selector: ".stage-now span" })).toBeTruthy();
    expect(stageTime()).toBe("0s");
    act(() => void vi.advanceTimersByTime(350));
    expect(stageTime()).toBe("1s");

    fireEvent.click(screen.getByRole("button", { name: /Pause/i }));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(stageTime()).toBe("1s");
    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));
    expect(stageTime()).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    expect(stageTime()).toBeUndefined();
    act(() => void vi.advanceTimersByTime(550));
    expect(stageTime()).toBe("0s");
  });

  it("moves focus and selection with the tablist keys", async () => {
    render(<Demo />);
    const first = screen.getByRole("tab", { name: /Critical bug/ });
    const second = screen.getByRole("tab", { name: /Hostile fork/ });
    const last = screen.getByRole("tab", { name: /Quiet pass/ });
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    act(() => first.focus());

    fireEvent.keyDown(first, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(second));
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(first.tabIndex).toBe(-1);
    expect(second.tabIndex).toBe(0);

    fireEvent.keyDown(second, { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(last));
    fireEvent.keyDown(last, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(last));
    expect(last.getAttribute("aria-selected")).toBe("true");
  });

  it("replays, skips to the final finding, and switches scenarios", () => {
    render(<Demo />);
    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));
    expect(screen.getAllByText("Every session is treated as expired").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: /Quiet pass/i }));
    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));
    expect(screen.getByText("No findings")).toBeTruthy();
  });
});
