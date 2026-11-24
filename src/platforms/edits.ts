import type {
  BranchUpdateOutcome,
  PullActionOutcome,
  PullFieldEdit,
  PullLabel,
  PullOpenness,
  PullState,
} from "../shared/index.js";
import { platformLimitedUntil } from "./rate-limit.js";

// A pull request's labels and draft state, read and changed as the
// signed-in user. Each answers null when the platform could not be reached.

type LabelListing = { applied: string[]; available: PullLabel[]; truncated: boolean };

type LabelEdit = { add: readonly string[]; remove: readonly string[] };

type DraftState = { draft: boolean; state: PullState };

export type DetailsEdit = { title?: PullFieldEdit | undefined; body?: PullFieldEdit | undefined };

/**
 * A write's end: `unchanged` when there was nothing to send, `stale` when
 * what it was to replace changed, `not_found` for a 404.
 */
export type EditOutcome = "done" | "unchanged" | "refused" | "stale" | "not_found";

export interface PullEdits {
  labels(token: string, fullName: string, number: number): Promise<LabelListing | null>;
  editLabels(
    token: string,
    fullName: string,
    number: number,
    edit: LabelEdit,
  ): Promise<PullActionOutcome | null>;
  draft(token: string, fullName: string, number: number): Promise<DraftState | null>;
  /** `refused`, unsent, for a pull request that is not open; `done`, unsent, when it already is so. */
  setDraft(
    token: string,
    fullName: string,
    number: number,
    draft: boolean,
  ): Promise<PullActionOutcome | null>;
  /** Changes the title and description only while each still reads its `from`; `stale`, unsent, otherwise. */
  editDetails(
    token: string,
    fullName: string,
    number: number,
    edit: DetailsEdit,
  ): Promise<EditOutcome | null>;
  /** `unchanged`, unsent, when it already is so; `refused`, unsent, for one merged (or locked). */
  setOpenness(
    token: string,
    fullName: string,
    number: number,
    state: PullOpenness,
  ): Promise<EditOutcome | null>;
  /**
   * Brings the branch up to date with its base, if its head is still
   * `head`: `head_moved`, unsent, when it is not.
   */
  updateBranch(
    token: string,
    fullName: string,
    number: number,
    head: string,
  ): Promise<BranchUpdateOutcome | "head_moved" | null>;
}

/**
 * A refusal to push as `forbidden`, but one the platform made because the
 * user's allowance is used up: null, which the request answers as that.
 */
export const forbiddenUnlessLimited = (): "forbidden" | null =>
  platformLimitedUntil() === null ? "forbidden" : null;

/** A platform's label colour as `#rrggbb`: GitHub writes it without the `#`. */
export function labelColor(color: unknown): string | null {
  const hex = typeof color === "string" ? /^#?([0-9a-f]{6})$/i.exec(color)?.[1] : undefined;
  return hex ? `#${hex.toLowerCase()}` : null;
}

/** Names compared as the platforms compare them, without case. */
export const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A write's or a read's status as an edit's end: a 403 the user's used-up
 * allowance caused is null, which the request answers as that.
 */
export function editOutcome(
  sent: { status: number } | null,
): Exclude<EditOutcome, "unchanged"> | null {
  if (!sent) return null;
  const { status } = sent;
  if (status >= 200 && status < 300) return "done";
  if (status === 404) return "not_found";
  if (status === 409) return "stale";
  if (status === 403) return forbiddenUnlessLimited() && "refused";
  if (status >= 400 && status < 500 && status !== 429) return "refused";
  return null;
}

/** Text as the page last showed it is still the platform's; a browser's form rewrites line endings. */
const unchanged = (now: string, seen: string) =>
  now.replace(/\r\n?/g, "\n") === seen.replace(/\r\n?/g, "\n");

/** The edit's fields that would change something, or "stale" when one no longer reads its `from`. */
export function plannedDetails(now: { title: string; body: string }, edit: DetailsEdit) {
  const fields = (["title", "body"] as const).filter((f) => edit[f] !== undefined);
  if (fields.some((f) => !unchanged(now[f], edit[f]?.from ?? ""))) return "stale" as const;
  return fields.filter((f) => !unchanged(now[f], edit[f]?.to ?? ""));
}
