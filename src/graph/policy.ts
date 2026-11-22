import { GRAPH_POLICIES, type GraphPolicy } from "../shared/index.js";

/** CODE_GRAPH: keep when unset; throws on anything else. */
export function graphPolicy(value: string | undefined): GraphPolicy {
  if (!value) return "keep";
  const policy = GRAPH_POLICIES.find((p) => p === value);
  if (!policy)
    throw new Error(`CODE_GRAPH must be one of ${GRAPH_POLICIES.join(", ")}, not ${value}`);
  return policy;
}
