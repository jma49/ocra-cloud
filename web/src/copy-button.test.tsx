import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./copy-button.js";

const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockClear();
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const press = () =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name: "Copy link" })));

describe("the copy button", () => {
  it("copies its text, says so, and goes back after a moment", async () => {
    render(
      <CopyButton text={() => "https://example.test/x"} label="Copy link" said="Link copied" />,
    );
    expect(screen.queryByText("Link copied")).toBeNull();
    await press();
    expect(writeText).toHaveBeenCalledWith("https://example.test/x");
    expect(screen.getByText("Link copied")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.queryByText("Link copied")).toBeNull();
  });

  it("does not say it copied when the browser refuses", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<CopyButton text="x" label="Copy link" said="Link copied" />);
    await press();
    expect(screen.queryByText("Link copied")).toBeNull();
  });
});
