import { cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useClearance } from "./clearance.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Page() {
  const [head, setHead] = useState<HTMLElement | null>(null);
  useClearance(head);
  return <header ref={setHead} style={{ top: 56 }} />;
}

describe("a pull request page's clearance", () => {
  it("follows the sticky head's height, and goes with the page", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(104.5);
    const page = render(<Page />);
    const clear = () => document.documentElement.style.getPropertyValue("--pull-clear");
    expect(clear()).toBe("173px");
    page.unmount();
    expect(clear()).toBe("");
  });
});
