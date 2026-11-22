import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_PLATFORMS } from "../../src/shared/index.js";
import { PlatformMark } from "./platform-mark.js";

afterEach(cleanup);

describe("PlatformMark", () => {
  it("draws each platform in the text colour, hidden from assistive tech", () => {
    const drawn = CODE_PLATFORMS.map((platform) => {
      const { container } = render(<PlatformMark platform={platform} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("fill")).toBe("currentColor");
      expect(svg?.getAttribute("width")).toBe("16");
      return svg?.querySelector("path")?.getAttribute("d");
    });
    expect(drawn.every(Boolean)).toBe(true);
    expect(new Set(drawn).size).toBe(CODE_PLATFORMS.length);
  });
});
