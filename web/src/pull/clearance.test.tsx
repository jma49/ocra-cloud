import { cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useClearance } from "./clearance.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Page(props: { position: "sticky" | "static" }) {
  const [head, setHead] = useState<HTMLElement | null>(null);
  useClearance(head);
  return <header ref={setHead} style={{ position: props.position, top: 56 }} />;
}

const clear = () => document.documentElement.style.getPropertyValue("--pull-clear");

describe("a pull request page's clearance", () => {
  it("follows the sticky head's height, and goes with the page", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(104.5);
    const page = render(<Page position="sticky" />);
    expect(clear()).toBe("173px");
    page.unmount();
    expect(clear()).toBe("");
  });

  it("clears only the page bar when a narrow window lets the head scroll away", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(48);
    render(
      <>
        <div className="pagebar" style={{ position: "sticky", top: 48 }} />
        <Page position="static" />
      </>,
    );
    expect(clear()).toBe("108px");
  });
});
