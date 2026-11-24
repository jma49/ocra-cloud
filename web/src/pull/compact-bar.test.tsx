import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactBar } from "./compact-bar.js";

type Seen = (entries: Partial<IntersectionObserverEntry>[]) => void;
let report: Seen = () => {};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubObserver() {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(seen: Seen) {
        report = seen;
      }
      observe() {}
      disconnect() {}
    },
  );
}

function Page() {
  const [head, setHead] = useState<HTMLElement | null>(null);
  return (
    <>
      <header ref={setHead}>
        <h1>Cap refunds</h1>
      </header>
      <CompactBar
        head={head}
        number="482"
        title="Cap refunds"
        status={<span>Ready to merge</span>}
        actions={<button type="button">Merge</button>}
        onAnchor={() => {}}
      />
    </>
  );
}

const scrolled = (isIntersecting: boolean, top: number) =>
  act(() => report([{ isIntersecting, boundingClientRect: { top } as DOMRectReadOnly }]));

describe("the line that stands for a pull request's head", () => {
  it("shows once the head has gone up past the page bar, and goes when it is back", () => {
    stubObserver();
    render(<Page />);
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    scrolled(false, -200);
    expect(screen.getByText("#482")).toBeTruthy();
    expect(screen.getByText("Ready to merge")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    scrolled(true, 40);
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("stays away while the head is still below the window", () => {
    stubObserver();
    render(<Page />);
    scrolled(false, 2000);
    expect(screen.queryByText("#482")).toBeNull();
  });
});
