import type { FixProposalsView, FixProposalView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useLoad } from "../ui.js";

const NONE: FixProposalView[] = [];

/** The open fixes the API path answers; none while loading, or when they could not be read. */
export function useFixes(path: string | null): FixProposalView[] {
  const { data } = useLoad(
    () => (path ? api<FixProposalsView>(path) : Promise.resolve(null)),
    [path],
  );
  return data?.fixes ?? NONE;
}
