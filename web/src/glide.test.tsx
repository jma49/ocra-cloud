import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useHoverGlide, usePickedGlide } from "./glide.js";

afterEach(cleanup);

function Links() {
  const nav = useRef<HTMLElement>(null);
  useHoverGlide(nav, "a");
  return (
    <nav ref={nav} aria-label="Links">
      <a href="/one">One</a>
      <a href="/two">Two</a>
    </nav>
  );
}

function Choices() {
  const [picked, setPicked] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);
  usePickedGlide(group, "[aria-pressed=true]");
  return (
    <div ref={group} data-testid="choices">
      {["A", "B"].map((c) => (
        <button key={c} type="button" aria-pressed={picked === c} onClick={() => setPicked(c)}>
          {c}
        </button>
      ))}
    </div>
  );
}

const over = (el: Element, pointerType: string) =>
  fireEvent(el, pointer("pointerover", pointerType));

function pointer(type: string, pointerType: string) {
  const e = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(e, "pointerType", { value: pointerType });
  return e;
}

describe("the gliding highlight", () => {
  it("follows a mouse over the items, not a touch, and hides when the mouse leaves", () => {
    render(<Links />);
    const nav = screen.getByRole("navigation", { name: "Links" });
    over(screen.getByText("One"), "touch");
    expect(nav.dataset.glide).toBeUndefined();
    over(screen.getByText("Two"), "mouse");
    expect(nav.dataset.glide).toBe("on");
    expect(nav.style.getPropertyValue("--glide-w")).toBe("0px");
    fireEvent(nav, pointer("pointerleave", "mouse"));
    expect(nav.dataset.glide).toBe("off");
  });

  it("sits on the picked item once there is one", () => {
    render(<Choices />);
    const group = screen.getByTestId("choices");
    expect(group.dataset.glide).toBe("off");
    fireEvent.click(screen.getByText("B"));
    expect(group.dataset.glide).toBe("on");
  });
});
