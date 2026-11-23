import type { FixProposalsView, FixProposalView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useLoad } from "../ui.js";

const NONE: FixProposalView[] = [];

/** The open fixes the API path answers; none while loading, or when they could not be read. */
export function useFixes(path: string | null): FixProposalView[] {
  return useFixesRead(path).fixes;
}

/** The same, with a way to read them again. */
export function useFixesRead(path: string | null) {
  const { data, reload } = useLoad(
    () => (path ? api<FixProposalsView>(path) : Promise.resolve(null)),
    [path],
  );
  return { fixes: data?.fixes ?? NONE, reload };
}
