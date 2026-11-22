import { parseGraph, serializeGraph, updateGraph } from "@open-cr-agent/code-graph";
import type { GraphBuilder } from "../graph/builder.js";
import type { GraphParser } from "../graph/impact-route.js";

/** The engine's tree-sitter graph: a previous graph it cannot read is rebuilt from scratch. */
export const engineGraphBuilder: GraphBuilder = async (input) => {
  const update = await updateGraph(
    input.previous === undefined ? undefined : parseGraph(input.previous),
    input.tree,
    input.readBlob,
    { revision: input.revision, maxBlobBytes: input.maxBlobBytes, signal: input.signal },
  );
  return {
    graph: serializeGraph(update.graph),
    files: update.graph.files.size,
    parsed: update.parsed,
    reused: update.reused,
    skipped: update.skipped.length,
  };
};

export const engineGraphParser: GraphParser = parseGraph;
