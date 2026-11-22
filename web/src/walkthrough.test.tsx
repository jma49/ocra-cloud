import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Walkthrough } from "./pages/review-walkthrough.js";

afterEach(cleanup);

describe("a review's walkthrough", () => {
  it("shows the overview, each group with its files, and the diagram as text", () => {
    const { container } = render(
      <Walkthrough
        w={{
          overview: "Refunds now check what is left. <img src=x onerror=alert(1)>",
          groups: [
            { title: "Refund limit", files: ["src/refunds/partial.ts"], note: "The check moved." },
          ],
          diagram: "graph TD; A-->B",
          redacted: true,
          truncated: false,
        }}
      />,
    );
    expect(screen.getByText(/Refunds now check what is left/)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Refund limit")).toBeTruthy();
    expect(screen.getByTitle("src/refunds/partial.ts").textContent).toBe("src/refunds/partial.ts");
    expect(screen.getByText("graph TD; A-->B")).toBeTruthy();
    expect(screen.getByText("secrets redacted")).toBeTruthy();
  });
});
