import type { GraphRepo } from "@open-cr-agent/cloud-contract";

/**
 * What a deployment does with code graphs (CODE_GRAPH): keep them for the
 * repositories an account adds, keep them only where the owner agreed when
 * adding one, or build none.
 */
export const GRAPH_POLICIES = ["keep", "opt-in", "off"] as const;
export type GraphPolicy = (typeof GRAPH_POLICIES)[number];

/**
 * A repository the server keeps a code graph of, with its newest build: the
 * contract's listing, and what the console links with.
 */
export type GraphRepoView = GraphRepo & {
  /** Its web address, under the instance's relative root. */
  url: string;
  /** The name the CLI gives a clone of it (`https://host/path`, lower case), which reviews upload. */
  identity: string;
};
