import { GRAPH_BUILD_STATES } from "@open-cr-agent/cloud-contract";
import { z } from "zod";
import { COMMIT_ID } from "../platforms/contents.js";
import type { ImpactView } from "../shared/index.js";
import { MAX_SYMBOLS, MAX_USES } from "./impact.js";

// What a pull request reaches, as a runner sends it to be kept: the answer
// of GET /api/graphs/repos/:id/impact with its pull request worked out.

const line = z.number().int().min(1);
const path = z.string().min(1).max(4096);
const name = z.string().min(1).max(500);
const commit = z.string().regex(COMMIT_ID);
const count = z.number().int().min(0);

const use = z.object({
  path,
  line,
  within: name.nullable(),
  code: z.string().max(240).nullable(),
});

const symbol = z.object({
  name,
  kind: z.string().min(1).max(100),
  path,
  startLine: line,
  endLine: line,
  change: z.enum(["signature", "body", "added"]),
  lines: z.array(z.tuple([line, line])).max(10_000),
  uses: z.array(use).max(MAX_USES),
  useCount: count,
  fileCount: count,
});

export const impactViewSchema = z.object({
  pull: z.object({
    base: commit,
    head: commit,
    files: count,
    truncated: z.boolean(),
    unread: count,
  }),
  graph: z
    .object({
      commit,
      current: z.boolean(),
      truncated: z.boolean(),
      files: count.nullable(),
    })
    .nullable(),
  build: z
    .object({
      state: z.enum(GRAPH_BUILD_STATES),
      commit,
      error: z.string().max(100).nullable(),
    })
    .nullable(),
  symbols: z.array(symbol).max(MAX_SYMBOLS),
  more: count,
}) satisfies z.ZodType<ImpactView>;
