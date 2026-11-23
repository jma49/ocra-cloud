import { keptImpactRoute } from "./kept-impact.js";
import { graphPolicy } from "./policy.js";
import type { GraphService } from "./routes.js";

// A host that neither builds a graph nor reads one (the Worker: a request
// there has no time to parse one, and its database is small) still keeps
// them: remote runners build each graph and work out each reviewed pull
// request's impact (./runner-api.ts), and the server stores what they send.

/** An account at both caps stores about 53 MB of text, a tenth of a D1 database on the free plan. */
const MAX_REPOS = 5;
const MAX_GRAPH_BYTES = 8 * 1024 * 1024;

/** The service CODE_GRAPH asks for; undefined when it is off. */
export function remoteGraphs(vars: { CODE_GRAPH?: string | undefined }): GraphService | undefined {
  const policy = graphPolicy(vars.CODE_GRAPH);
  if (policy === "off") return undefined;
  return {
    policy,
    // Nothing to wake: a runner asks for work on its own clock.
    kick: () => {},
    impact: keptImpactRoute,
    remote: { maxRepos: MAX_REPOS, maxGraphBytes: MAX_GRAPH_BYTES },
  };
}
