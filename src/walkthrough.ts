import { redactField, type SharedWalkthrough } from "@open-cr-agent/cloud-contract";
import type { ReviewWalkthroughView } from "./shared/index.js";

// A review's walkthrough as the CLI shares it with its findings, redacted
// again on the server, as findings are (./findings.ts): a client that
// skipped its own pass gets no more stored.

export function parseWalkthrough(
  w: SharedWalkthrough | undefined,
): ReviewWalkthroughView | undefined {
  if (!w) return undefined;
  let redacted = w.redacted === true;
  let truncated = w.truncated === true;
  const text = (v: string) => {
    const r = redactField(v);
    redacted ||= r.redacted;
    truncated ||= r.truncated;
    return r.text;
  };
  const overview = text(w.overview);
  const groups = w.groups.map((g) => ({
    title: text(g.title),
    files: g.files.map(text),
    note: text(g.note),
  }));
  const diagram = w.diagram ? text(w.diagram) : null;
  return { overview, groups, diagram, redacted, truncated };
}
