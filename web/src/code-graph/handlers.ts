import type { GRAPH_COMMIT_HEADER } from "@open-cr-agent/cloud-contract";
import { layoutMap, type Placed } from "./layout.js";
import { buildModel, type Model } from "./model.js";
import {
  type FileFocus,
  focusFile,
  focusSymbol,
  type Hit,
  locate,
  type MapView,
  mapOf,
  type SymbolFocus,
  search,
} from "./queries.js";

// What the explorer asks of a loaded graph and how each is answered, the
// same in the worker and, where there is none, in the page.

export type Request =
  | { type: "map"; folder: string }
  | { type: "focus"; path: string; symbol?: { name: string; line?: number } }
  | { type: "search"; query: string };

export type Answers = {
  map: { view: MapView; placed: Placed[] };
  focus: FileFocus | SymbolFocus | null;
  search: Hit[];
};
export type Answer = Answers[keyof Answers];

export type Loaded = { commit: string; files: number; symbols: number };

export type LoadEvent =
  | { type: "progress"; bytes: number }
  | { type: "indexing" }
  | ({ type: "ready" } & Loaded)
  | { type: "failed"; status: number };

const COMMIT_HEADER: typeof GRAPH_COMMIT_HEADER = "x-ocra-graph-commit";

/** Reads a repository's newest graph from the API and indexes it, saying how far it got. */
export async function loadGraph(
  repo: string,
  emit: (e: LoadEvent) => void,
): Promise<Model | undefined> {
  const res = await fetch(`/api/graphs/repos/${encodeURIComponent(repo)}/graph`).catch(() => null);
  if (!res?.ok || !res.body) {
    emit({ type: "failed", status: res?.status ?? 0 });
    return undefined;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let told = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.byteLength;
    if (bytes - told > 256 * 1024) {
      told = bytes;
      emit({ type: "progress", bytes });
    }
  }
  emit({ type: "indexing" });
  const text = await new Blob(chunks as BlobPart[]).text();
  const model = buildModel(text, res.headers.get(COMMIT_HEADER) ?? "");
  if (!model) {
    emit({ type: "failed", status: 422 });
    return undefined;
  }
  emit({
    type: "ready",
    commit: model.commit,
    files: model.files.length,
    symbols: model.defs.length,
  });
  return model;
}

export function answer(m: Model, req: Request): Answer {
  switch (req.type) {
    case "map": {
      const view = mapOf(m, req.folder);
      return { view, placed: layoutMap(view) };
    }
    case "focus": {
      const at = locate(m, req.path, req.symbol);
      if (!at) return null;
      return at.def === undefined ? focusFile(m, at.file) : focusSymbol(m, at.def);
    }
    case "search":
      return search(m, req.query);
  }
}
