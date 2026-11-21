// What a deployment does with code graphs (CODE_GRAPH): keep them for the
// repositories an account adds (with history pruned and a purge), keep
// them only for repositories whose owner agreed when adding them, or build
// and keep none.

const GRAPH_POLICIES = ["keep", "opt-in", "off"] as const;
export type GraphPolicy = (typeof GRAPH_POLICIES)[number];

/** CODE_GRAPH: keep when unset; throws on anything else. */
export function graphPolicy(value: string | undefined): GraphPolicy {
  if (!value) return "keep";
  const policy = GRAPH_POLICIES.find((p) => p === value);
  if (!policy)
    throw new Error(`CODE_GRAPH must be one of ${GRAPH_POLICIES.join(", ")}, not ${value}`);
  return policy;
}
