// Mermaid writes its styles into the SVG as a <style> element and style
// attributes, which the console's CSP (style-src 'self') refuses. This moves
// them out of the markup so they can be applied through the CSSOM instead.

export const STYLE_MARK = "data-ocra-style";

/** The SVG with its <style> elements taken out and its style attributes parked under STYLE_MARK, and the CSS those elements held. */
export function liftStyles(markup: string): { svg: SVGSVGElement; css: string } | null {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.nodeName !== "svg" || doc.querySelector("parsererror")) return null;
  const css = [...svg.querySelectorAll("style")]
    .map((s) => {
      s.remove();
      return s.textContent ?? "";
    })
    .join("\n");
  for (const el of svg.querySelectorAll("[style]")) {
    el.setAttribute(STYLE_MARK, el.getAttribute("style") ?? "");
    el.removeAttribute("style");
  }
  return { svg: svg as unknown as SVGSVGElement, css };
}

/** Applies each parked style attribute under `root` through the CSSOM, which style-src does not govern. */
export function applyParkedStyles(root: ParentNode) {
  for (const el of root.querySelectorAll<SVGElement>(`[${STYLE_MARK}]`)) {
    for (const [name, value] of declarations(el.getAttribute(STYLE_MARK) ?? "")) {
      const important = /\s*!important\s*$/i;
      el.style.setProperty(
        name,
        value.replace(important, ""),
        important.test(value) ? "important" : "",
      );
    }
    el.removeAttribute(STYLE_MARK);
  }
}

// Splits "a: b; c: url(x;y)" on the semicolons outside parentheses and quotes.
function declarations(text: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  const take = (end: number) => {
    const decl = text.slice(start, end);
    const colon = decl.indexOf(":");
    if (colon > 0) out.push([decl.slice(0, colon).trim(), decl.slice(colon + 1).trim()]);
    start = end + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) take(i);
  }
  take(text.length);
  return out;
}
