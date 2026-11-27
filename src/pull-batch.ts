import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Row } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import type { FileFixes } from "./platforms/actions.js";
import { type FixSkip, fixMessage, type LineFix, repoFilePath } from "./platforms/fix.js";
import type { CodePlatform } from "./platforms/platform.js";
import { findingsOfSuggestions, suggestionMessage } from "./platforms/threads.js";
import { byKind, reach } from "./pull-page.js";
import { pullRef, sha } from "./pull-ref.js";
import { findingsOn, platformId } from "./pull-threads.js";
import { perMinute } from "./rate.js";
import { pullOfReview, pullOnPlatform } from "./review-pull.js";
import { fixOf } from "./reviews.js";
import { requireSession } from "./session.js";
import {
  BATCH_ITEM_KINDS,
  type BatchItemKind,
  type BatchItemOutcome,
  type BatchSkipReason,
  MAX_BATCH_ITEMS,
  type PullActionOutcome,
  type PullBatchRequest,
  type PullBatchView,
  replacementLines,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// Several of ocra's checked fixes and review suggestions committed to a pull
// request together, as the signed-in user: one commit of the head they saw,
// through the same platform path as one fix. Each item answers whether it was
// applied, or why not.

export const pullBatch = new Hono<AppEnv>();

const batchBody = z.object({
  ...pullRef,
  head: sha,
  items: z
    .array(z.object({ kind: z.enum(BATCH_ITEM_KINDS), id: platformId }))
    .min(1)
    .max(MAX_BATCH_ITEMS)
    .refine(
      (items) => new Set(items.map((i) => `${i.kind}:${i.id}`)).size === items.length,
      "an item twice",
    ),
});

/** An item's change to one file, or why it has none. */
type Edit = { path: string; fix: LineFix } | BatchSkipReason;
/** Where an edit went in the commit: its file and its fix there. */
type Place = { file: number; fix: number };

const sameEdit = (a: LineFix, b: LineFix) =>
  a.startLine === b.startLine &&
  a.endLine === b.endLine &&
  replacementLines(a.replacement).join("\n") === replacementLines(b.replacement).join("\n");

/**
 * The edits grouped by file, in the order given. An edit the same as an
 * earlier one shares its place; one that changes any of an earlier one's
 * lines otherwise is a conflict, so the earlier wins whatever the platform.
 */
export function combineEdits(edits: readonly Edit[]): {
  files: FileFixes[];
  places: (Place | BatchSkipReason)[];
} {
  const files: FileFixes[] = [];
  const places = edits.map((edit): Place | BatchSkipReason => {
    if (typeof edit === "string") return edit;
    let file = files.findIndex((f) => f.path === edit.path);
    if (file < 0) file = files.push({ path: edit.path, fixes: [] }) - 1;
    const fixes = files[file]?.fixes ?? [];
    const same = fixes.findIndex((f) => sameEdit(f, edit.fix));
    if (same >= 0) return { file, fix: same };
    const overlaps = fixes.some(
      (f) => f.startLine <= edit.fix.endLine && edit.fix.startLine <= f.endLine,
    );
    if (overlaps) return "conflict";
    return { file, fix: fixes.push(edit.fix) - 1 };
  });
  return { files, places };
}

/** The commit's message for the findings, by title, and suggestions it applies. */
export function batchMessage(titles: readonly string[], suggestions: number): string {
  const [title] = titles;
  if (titles.length === 0) return suggestionMessage(suggestions);
  if (titles.length === 1 && title !== undefined && suggestions === 0) return fixMessage(title);
  const fixes = titles.length === 1 ? "1 fix" : `${titles.length} fixes`;
  const also =
    suggestions === 0 ? "" : ` and ${suggestions} suggestion${suggestions > 1 ? "s" : ""}`;
  return `Apply ${fixes} from ocra${also}`;
}

/** The findings' edits: their fixes, when they are of this pull request at `head`. */
async function findingEdits(
  c: Context<AppEnv>,
  platform: CodePlatform,
  body: PullBatchRequest,
  ids: readonly string[],
): Promise<Map<string, { edit: Edit; finding?: Row<"findings"> }>> {
  const reviews = new Map<string, Row<"reviews"> | undefined>();
  const edits = new Map<string, { edit: Edit; finding?: Row<"findings"> }>();
  for (const id of ids) {
    const finding = await c.var.data.get("findings", id);
    if (finding && !reviews.has(finding.reviewId)) {
      reviews.set(finding.reviewId, await c.var.data.get("reviews", finding.reviewId));
    }
    const review = finding && reviews.get(finding.reviewId);
    const reviewed = review && pullOfReview(review);
    const on = reviewed && pullOnPlatform([platform], reviewed)?.pull;
    const ofPull =
      on && on.repo.toLowerCase() === body.repo.toLowerCase() && on.number === body.number;
    if (!finding || !reviewed || !ofPull) {
      edits.set(id, { edit: "not_found" });
      continue;
    }
    const fix = fixOf(finding);
    const path = repoFilePath(finding.file);
    const edit: Edit = !fix
      ? "no_fix"
      : reviewed.head !== body.head
        ? "stale"
        : !path
          ? "not_applicable"
          : { path, fix };
    edits.set(id, { edit, finding });
  }
  return edits;
}

/** The applied findings fixed, with an audit event each, and the findings of the applied suggestions. */
async function markApplied(
  c: Context<AppEnv>,
  platform: CodePlatform,
  body: PullBatchRequest,
  items: readonly BatchItemOutcome[],
  threads: Parameters<typeof findingsOfSuggestions>[0],
) {
  const applied = (kind: BatchItemKind) =>
    items.filter((i) => i.applied && i.kind === kind).map((i) => i.id);
  const fixed = applied("finding");
  await c.var.data.findingOutcomes.markFixed(fixed, "applied");
  const pull = `${body.repo}#${body.number}`;
  for (const finding of fixed) await audit(c.var.data, "pull.fix_applied", { pull, finding });
  const findings = findingsOfSuggestions(threads, applied("suggestion"));
  await c.var.data.findingOutcomes.markFixedOnPull(
    findingsOn(platform, body, { findings }),
    "suggestion",
  );
}

/** Why the item at `place` was left out, or null when its fix was not. */
function skipOf(
  place: Place | BatchSkipReason | undefined,
  skipped: (FixSkip | null)[][],
): BatchSkipReason | null {
  if (place === undefined) return "not_found";
  if (typeof place === "string") return place;
  return skipped[place.file]?.[place.fix] ?? null;
}

const everyItem = (body: PullBatchRequest, outcome: PullActionOutcome, reason: BatchSkipReason) =>
  ({
    outcome,
    items: body.items.map((i) => ({ kind: i.kind, id: i.id, applied: false, reason })),
  }) satisfies PullBatchView;

pullBatch.post(
  "/apply-batch",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(batchBody),
  async (c) => {
    const body: PullBatchRequest = c.req.valid("json");
    const reached = await reach(c, byKind(body));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const idsOf = (kind: string) => body.items.filter((i) => i.kind === kind).map((i) => i.id);
    const findings = await findingEdits(c, platform, body, idsOf("finding"));
    const wanted = idsOf("suggestion");
    const listing =
      wanted.length > 0 ? await platform.threads.list(token, body.repo, body.number) : null;
    if (wanted.length > 0 && !listing) return apiError(c, "upstream_unreachable");
    if (listing && listing.head !== body.head) {
      return c.json(everyItem(body, "head_moved", "not_sent"));
    }
    const suggestions = new Map(
      (listing?.threads ?? []).flatMap((t) =>
        t.comments.flatMap((cm) => cm.suggestions.map((s) => [s.id, s] as const)),
      ),
    );
    const edits = body.items.map((item): Edit => {
      if (item.kind === "finding") return findings.get(item.id)?.edit ?? "not_found";
      const s = suggestions.get(item.id);
      if (!s) return "not_found";
      if (!s.applicable) return "stale";
      const path = repoFilePath(s.path);
      return path ? { path, fix: s.fix } : "not_applicable";
    });
    const { files, places } = combineEdits(edits);
    if (files.length === 0) {
      const items = body.items.map((i, n) => {
        const place = places[n];
        const reason = typeof place === "string" ? place : "not_sent";
        return { kind: i.kind, id: i.id, applied: false, reason };
      });
      return c.json({ outcome: "not_applicable", items } satisfies PullBatchView);
    }
    const appliedIn = (skipped: (FixSkip | null)[][]) =>
      body.items.filter((_, n) => skipOf(places[n], skipped) === null);
    const commit = await platform.actions.applyFixes(token, body.repo, body.number, {
      head: body.head,
      files,
      partial: true,
      message: (skipped) => {
        const applied = appliedIn(skipped);
        const titles = applied.flatMap((i) =>
          i.kind === "finding" ? [findings.get(i.id)?.finding?.title ?? ""] : [],
        );
        return batchMessage(titles, applied.length - titles.length);
      },
    });
    if (!commit) return apiError(c, "upstream_unreachable");
    const done = commit.outcome === "done";
    const items = body.items.map((item, n) => {
      const skip = skipOf(places[n], commit.skipped) ?? (done ? null : "not_sent");
      return { kind: item.kind, id: item.id, applied: skip === null, reason: skip };
    });
    if (done) await markApplied(c, platform, body, items, listing?.threads ?? []);
    return c.json({ outcome: commit.outcome, items } satisfies PullBatchView);
  },
);
