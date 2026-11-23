import { gunzipSync, gzipSync } from "node:zlib";
import type { BuildFailure } from "../graph/runner.js";
import type { GraphAssignment } from "../graph/runner-api.js";
import type { ImpactView } from "../shared/index.js";
import type { LocalGraph } from "./local-graph.js";
import type { ReviewGraphs } from "./review-graph.js";

// A remote runner's graph calls to its server (src/graph/runner-api.ts).

type BuildRef = Pick<GraphAssignment, "id" | "accountId" | "attempts">;

export type RunnerGraphs = Required<ReviewGraphs> & {
  /** Sends a build's graph to be kept; one too large for the server ends the build as failed. */
  finish(build: BuildRef, built: LocalGraph): Promise<void>;
  fail(build: BuildRef, failure: BuildFailure): Promise<void>;
};

const CALL_TIMEOUT_MS = 120_000;

export function serverGraphs(server: string, token: string, fetcher = fetch): RunnerGraphs {
  const call = async (
    path: string,
    { accept, ...init }: RequestInit & { accept?: number[] } = {},
  ) => {
    const res = await fetcher(new URL(`/api/runner/graphs/${path}`, server), {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok && !accept?.includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`runner_graphs_${res.status}`);
    }
    return res;
  };
  /** Posts the body; the answer's status, one of `accept` when it is not ok. */
  const post = async (path: string, body: unknown, accept: number[] = []) => {
    const res = await call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      accept,
    });
    await res.body?.cancel().catch(() => {});
    return res.status;
  };
  const fail = (build: BuildRef, failure: BuildFailure) =>
    post(buildPath(build), { accountId: build.accountId, attempts: build.attempts, failure });
  const buildPath = (build: BuildRef) => `builds/${encodeURIComponent(build.id)}`;
  return {
    async newest(accountId, repoId, signal) {
      const query = new URLSearchParams({ account: accountId });
      const res = await call(`repos/${encodeURIComponent(repoId)}/graph?${query}`, {
        signal,
        accept: [404],
      });
      if (res.ok) return gunzipSync(new Uint8Array(await res.arrayBuffer())).toString();
      await res.body?.cancel().catch(() => {});
      return undefined;
    },
    async keepImpact(accountId: string, graphRepoId: string, number: number, view: ImpactView) {
      await post("impacts", { accountId, graphRepoId, number, view });
    },
    async finish(build, built) {
      const status = await post(
        buildPath(build),
        {
          accountId: build.accountId,
          attempts: build.attempts,
          graph: gzipSync(built.graph).toString("base64"),
          files: built.files,
          parsed: built.parsed,
          reused: built.reused,
          skipped: built.skipped,
        },
        [413],
      );
      // The server reads no body past the largest graph it keeps.
      if (status === 413) await fail(build, "too_large");
    },
    async fail(build, failure) {
      await fail(build, failure);
    },
  };
}
