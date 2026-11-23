import type { z } from "zod";
import { GITHUB_SIGNAL_FIELDS } from "../merge-when-ready/hooks.js";
import { GITHUB_COMMENT_FIELDS, GITLAB_COMMENT_FIELDS } from "../notify/comment-hooks.js";
import { GITHUB_HOOK_FIELDS, GITLAB_HOOK_FIELDS } from "../notify/pull-hooks.js";
import { GITHUB_THREAD_FIELDS, GITLAB_THREAD_FIELDS } from "../notify/thread-hooks.js";

// What a delivery's work keeps of its body: the fields its side effects'
// own schemas read, each schema's parse (which drops every key it does not
// name) merged into one object. Diffs, descriptions, URLs and whatever else
// a platform sends are never stored; the side effects read this in place of
// the body, on the first attempt too.

const GITHUB: readonly z.ZodType[] = [
  ...GITHUB_HOOK_FIELDS,
  ...GITHUB_COMMENT_FIELDS,
  ...GITHUB_THREAD_FIELDS,
  ...GITHUB_SIGNAL_FIELDS,
];
const GITLAB: readonly z.ZodType[] = [
  ...GITLAB_HOOK_FIELDS,
  ...GITLAB_COMMENT_FIELDS,
  ...GITLAB_THREAD_FIELDS,
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function merge(a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => merge(a[i], b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
    return out;
  }
  return b === undefined ? a : b;
}

/** The parts of body that any of schemas reads. */
function fieldsOf(body: unknown, schemas: readonly z.ZodType[]): Record<string, unknown> {
  let kept: unknown;
  for (const schema of schemas) {
    const parsed = schema.safeParse(body);
    if (parsed.success) kept = merge(kept, parsed.data);
  }
  return isRecord(kept) ? kept : {};
}

export const githubFields = (body: unknown) => fieldsOf(body, GITHUB);
export const gitlabFields = (body: unknown) => fieldsOf(body, GITLAB);
