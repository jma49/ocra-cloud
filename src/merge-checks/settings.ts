import { MAX_MERGE_CHECK_INSTRUCTION } from "@open-cr-agent/cloud-contract";
import { z } from "zod";
import {
  MERGE_CHECK_KINDS,
  MERGE_CHECK_MODES,
  type MergeCheckKind,
  type MergeCheckSettings,
} from "../shared/index.js";

// Each check kind's settings, read on the way in from the console and on
// the way out of the database. A title is matched against prefixes or a
// glob, never a regular expression the account wrote (no ReDoS).

const phrase = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/\p{Cc}/u.test(s), "no control characters");

/** A glob of literal text, `*` (any run) and `?` (any one character). */
const MAX_GLOB = 100;

const SETTINGS = {
  linked_issue: z.strictObject({ open: z.boolean().optional(), label: phrase(50).optional() }),
  title: z
    .strictObject({
      prefixes: z.array(phrase(50)).min(1).max(20).optional(),
      glob: phrase(MAX_GLOB).optional(),
    })
    .refine((s) => s.prefixes !== undefined || s.glob !== undefined, "a prefix or a glob"),
  description: z.strictObject({ headings: z.array(phrase(80)).max(10).optional() }),
  size: z
    .strictObject({
      maxFiles: z.number().int().min(1).max(10_000).optional(),
      maxLines: z.number().int().min(1).max(1_000_000).optional(),
    })
    .refine((s) => s.maxFiles !== undefined || s.maxLines !== undefined, "a file or line limit"),
  critical_findings: z.strictObject({}),
  instruction: z.strictObject({ text: phrase(MAX_MERGE_CHECK_INSTRUCTION) }),
} satisfies { [K in MergeCheckKind]: z.ZodType<MergeCheckSettings[K]> };

const mode = z.enum(MERGE_CHECK_MODES);

/** Where settings do not fit their kind, as the body's issues under `settings`. */
function settingsIssues(kind: MergeCheckKind, settings: unknown, ctx: z.RefinementCtx) {
  const parsed = SETTINGS[kind].safeParse(settings);
  for (const issue of parsed.error?.issues ?? []) {
    ctx.addIssue({ code: "custom", message: issue.message, path: ["settings", ...issue.path] });
  }
}

/** A new check: its kind, mode and that kind's settings. */
export const addCheckBody = z
  .object({ kind: z.enum(MERGE_CHECK_KINDS), mode, settings: z.unknown().default({}) })
  .superRefine((b, ctx) => settingsIssues(b.kind, b.settings, ctx));

export const changeCheckBody = z
  .object({ mode: mode.optional(), settings: z.unknown().optional() })
  .refine((b) => b.mode !== undefined || b.settings !== undefined, "nothing to change");

/** The kind's settings, or undefined when they are not that kind's. */
export function settingsOf<K extends MergeCheckKind>(
  kind: K,
  settings: unknown,
): MergeCheckSettings[K] | undefined {
  const parsed = SETTINGS[kind].safeParse(settings);
  return parsed.success ? (parsed.data as MergeCheckSettings[K]) : undefined;
}
