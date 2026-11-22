import type { PatchedFile } from "./changes.js";
import { boundedBytes, platformRead } from "./http.js";

// What changed in a pull request since a head the user saw or reviewed:
// the diff from that head to the current one, read as the user for one
// request; nothing read is kept.

/** `rebased` when `since` is no ancestor of the head: a force push rewrote what was seen. */
export type SinceDiff =
  | { state: "changes"; files: PatchedFile[]; truncated: boolean }
  | { state: "rebased" };

/** The head the user's latest submitted review of the pull request was of. */
type ReviewedHead = { head: string; at: string | null };

export interface PullSince {
  /** null when the platform failed, knows no such commit, or answered more than one page reads. */
  diff(token: string, fullName: string, since: string, head: string): Promise<SinceDiff | null>;
  /** null when the user submitted none, or the platform could not be reached. */
  reviewed(token: string, fullName: string, number: number): Promise<ReviewedHead | null>;
}

/** A comparison's answer: its diffs and its commits, which neither platform leaves out. */
const MAX_COMPARE_BYTES = 8_000_000;

/** A comparison's JSON, or null past MAX_COMPARE_BYTES. */
export const compareCall = <T>(url: string, headers: Record<string, string>) =>
  platformRead(url, { headers }, async (res) => {
    const bytes = await boundedBytes(res, MAX_COMPARE_BYTES);
    if (!bytes) throw new Error("too large");
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  });
