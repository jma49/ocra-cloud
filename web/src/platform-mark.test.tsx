import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_PLATFORMS } from "../../src/shared/index.js";
import { PlatformMark } from "./platform-mark.js";

afterEach(cleanup);

describe("PlatformMark", () => {
  it("draws each platform through currentColor, so its class can give it the brand colour, hidden from assistive tech", () => {
    const drawn = CODE_PLATFORMS.map((platform) => {
      const { container } = render(<PlatformMark platform={platform} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("fill")).toBe("currentColor");
      expect(svg?.getAttribute("width")).toBe("16");
      expect(svg?.getAttribute("class")).toBe(`platform-mark is-${platform}`);
      return svg?.querySelector("path")?.getAttribute("d");
    });
    expect(drawn.every(Boolean)).toBe(true);
    expect(new Set(drawn).size).toBe(CODE_PLATFORMS.length);
  });
});
