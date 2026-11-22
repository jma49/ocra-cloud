import { useEffect, useRef, useState } from "react";
import { applyParkedStyles, liftStyles } from "./svg-styles.js";

// A walkthrough's Mermaid diagram, drawn in the browser. The text is model
// output about untrusted code: Mermaid runs in strict mode (labels are text,
// no links or scripts) and with SVG labels only, and the drawing lives in a
// shadow root so its styles stay off the page. Mermaid loads only here.

let ids = 0;

export function Diagram(props: { source: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const draw = async () => {
      const { default: mermaid } = await import("mermaid");
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        theme: dark ? "dark" : "neutral",
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font"),
      });
      const { svg } = await mermaid.render(`ocra-diagram-${++ids}`, props.source);
      const lifted = liftStyles(svg);
      const el = host.current;
      if (!live || !el) return;
      if (!lifted) throw new Error("not an SVG");
      const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`${lifted.css}\nsvg { max-width: 100%; height: auto; }`);
      root.adoptedStyleSheets = [sheet];
      root.replaceChildren(document.importNode(lifted.svg, true));
      applyParkedStyles(root);
    };
    draw().catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [props.source]);
  if (failed)
    return <p className="subtle small m-0">This diagram could not be drawn; its text is below.</p>;
  return (
    <div ref={host} className="walkthrough-drawing" role="img" aria-label="Diagram of the change" />
  );
}
