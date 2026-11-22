import { describe, expect, it } from "vitest";
import { applyParkedStyles, liftStyles, STYLE_MARK } from "./svg-styles.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><style>.node{fill:red}</style><g><rect style="fill: url(#a;b); stroke-width: 2px !important" /></g></svg>`;

describe("a drawn diagram's styles", () => {
  it("leave the markup: the <style> as CSS, each style attribute parked", () => {
    const lifted = liftStyles(SVG);
    expect(lifted?.css).toBe(".node{fill:red}");
    expect(lifted?.svg.querySelector("style")).toBeNull();
    expect(lifted?.svg.querySelector("[style]")).toBeNull();
    expect(lifted?.svg.querySelector("rect")?.getAttribute(STYLE_MARK)).toContain("stroke-width");
  });

  it("come back through the CSSOM, semicolons inside url() kept", () => {
    const lifted = liftStyles(SVG);
    const host = document.createElement("div");
    host.append(document.importNode(lifted?.svg as SVGSVGElement, true));
    applyParkedStyles(host);
    const rect = host.querySelector("rect") as SVGRectElement;
    expect(rect.hasAttribute(STYLE_MARK)).toBe(false);
    expect(rect.style.getPropertyValue("stroke-width")).toBe("2px");
    expect(rect.style.getPropertyPriority("stroke-width")).toBe("important");
  });

  it("refuse markup that is not an SVG", () => {
    expect(liftStyles("<div>not a diagram</div>")).toBeNull();
  });
});
