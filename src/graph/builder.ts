import type { TreeEntry } from "../platforms/contents.js";

// The engine's graph update, as the server calls it: the previous graph's
// serialized text, the commit's tree and a reader of its blobs in, the new
// graph's text and counts out. The server stores the text as opaque bytes.

export type GraphBuildInput = {
  previous: string | undefined;
  tree: readonly TreeEntry[];
  readBlob: (blobId: string, path: string) => Promise<Uint8Array | undefined>;
  revision: string;
  maxBlobBytes: number;
  signal: AbortSignal;
};

type GraphBuildOutput = {
  graph: string;
  files: number;
  parsed: number;
  reused: number;
  skipped: number;
};

export type GraphBuilder = (input: GraphBuildInput) => Promise<GraphBuildOutput>;
