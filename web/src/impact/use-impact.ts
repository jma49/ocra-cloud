import type { GraphRepoView, ImpactView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useCached } from "../cache.js";
import { graphRepoOf } from "./select.js";

type Repos = { repos: GraphRepoView[] };

export type Impact =
  | { state: "off" }
  | { state: "loading" }
  | { state: "unkept" }
  | { state: "error"; retry: () => void }
  | { state: "ready"; repo: GraphRepoView; view: ImpactView };

type PullRef = { repository: string; number: number } | null;

/** A review's pull request's impact, cache-first; off without a pull request or graphs. */
export function useImpact(pull: PullRef, graphs: boolean): Impact {
  const on = graphs && pull !== null;
  const repos = useCached(on ? "/graphs/repos" : "impact:off", () =>
    on ? api<Repos>("/graphs/repos") : Promise.resolve(null),
  );
  const repo = pull && repos.data ? graphRepoOf(repos.data.repos, pull.repository) : undefined;
  const path = repo && pull ? `/graphs/repos/${repo.id}/impact?pull=${pull.number}` : null;
  const impact = useCached(path ?? "impact:none", () =>
    path ? api<ImpactView>(path) : Promise.resolve(null),
  );
  if (!on) return { state: "off" };
  if (repos.error) return { state: "error", retry: repos.reload };
  if (!repos.data) return { state: "loading" };
  if (!repo) return { state: "unkept" };
  if (impact.error && !impact.data) return { state: "error", retry: impact.reload };
  if (!impact.data) return { state: "loading" };
  return { state: "ready", repo, view: impact.data };
}
