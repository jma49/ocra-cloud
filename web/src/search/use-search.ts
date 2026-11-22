import { useEffect, useState } from "react";
import { normaliseSearchQuery, type SearchResultsView } from "../../../src/shared/index.js";
import { api } from "../api.js";

// The search shares the platforms' request allowance, so a keystroke waits before it asks.
const WAIT_MS = 250;
const MIN_QUERY = 2;

/** What the server finds for a query: null until it answers, and for one too short to ask. */
export function useSearch(raw: string): { results: SearchResultsView | null; searching: boolean } {
  const query = normaliseSearchQuery(raw);
  const asks = query.length >= MIN_QUERY;
  const [answer, setAnswer] = useState<SearchResultsView | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!asks) return;
    let live = true;
    const timer = setTimeout(() => {
      api<SearchResultsView>(`/search?${new URLSearchParams({ q: query })}`).then(
        (view) => live && setAnswer(view),
        () => live && setFailedFor(query),
      );
    }, WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, asks]);
  const results = asks && answer?.query === query ? answer : null;
  return { results, searching: asks && !results && failedFor !== query };
}
