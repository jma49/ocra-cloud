import { useEffect, useState } from "react";
import { type GraphClient, openGraph } from "./client.js";
import type { Answers, Loaded, Request } from "./handlers.js";

// One repository's graph while its explorer is open: read and indexed once,
// then asked.

export type GraphLoad =
  | { state: "reading"; bytes: number }
  | { state: "indexing" }
  | ({ state: "ready"; client: GraphClient } & Loaded)
  | { state: "failed"; status: number };

export function useGraph(repo: string): GraphLoad {
  const [load, setLoad] = useState<GraphLoad>({ state: "reading", bytes: 0 });
  useEffect(() => {
    setLoad({ state: "reading", bytes: 0 });
    const client = openGraph(repo, (e) => {
      if (e.type === "progress") setLoad({ state: "reading", bytes: e.bytes });
      else if (e.type === "indexing") setLoad({ state: "indexing" });
      else if (e.type === "failed") setLoad({ state: "failed", status: e.status });
      else
        setLoad({ state: "ready", client, commit: e.commit, files: e.files, symbols: e.symbols });
    });
    return () => client.close();
  }, [repo]);
  return load;
}

export type Asked<T> = { data: T | undefined; error: unknown; busy: boolean };

/**
 * The answer to a request, asked again when it changes; the last answer
 * stays shown while the next is worked out, so the view never blanks.
 */
export function useAnswer<T extends Request["type"]>(
  client: GraphClient,
  request: Extract<Request, { type: T }>,
): Asked<Answers[T]> {
  const key = JSON.stringify(request);
  const [state, setState] = useState<Asked<Answers[T]>>({
    data: undefined,
    error: undefined,
    busy: true,
  });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, busy: true }));
    client.ask(JSON.parse(key) as Extract<Request, { type: T }>).then(
      (data) => live && setState({ data, error: undefined, busy: false }),
      (error: unknown) => live && setState({ data: undefined, error, busy: false }),
    );
    return () => {
      live = false;
    };
  }, [client, key]);
  return state;
}
