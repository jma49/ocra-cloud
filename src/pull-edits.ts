import { Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.js";
import { apiError, jsonBody } from "./http.js";
import { sameLabel } from "./platforms/edits.js";
import { byKind, reach } from "./pull-page.js";
import { pullRef, sha } from "./pull-ref.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import {
  MAX_LABEL_CHARS,
  MAX_LABEL_EDITS,
  type PullActionOutcome,
  type PullDraftRequest,
  type PullDraftView,
  type PullLabelsRequest,
  type PullLabelsView,
  type PullUpdateBranchAnswer,
  type PullUpdateBranchRequest,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's labels and draft state on its page, read live as the
// signed-in user and changed as them, and its branch brought up to date
// with its base as them. Nothing read or sent is kept but the audit entry,
// which names the labels, never the pull request's text.

export const pullEdits = new Hono<AppEnv>();

const refQuery = z.object(pullRef);
/** A name as written: a comma would split GitLab's list, a control character is no name. */
const labelName = z
  .string()
  .min(1)
  .max(MAX_LABEL_CHARS)
  .refine((n) => n.trim() !== "" && !/[,\p{Cc}]/u.test(n), "not a label name");
const distinct = (names: string[]) =>
  names.every((n, i) => names.findIndex((m) => sameLabel(m, n)) === i);
const labelsBody = z
  .object({
    ...pullRef,
    add: z.array(labelName).max(MAX_LABEL_EDITS).default([]),
    remove: z.array(labelName).max(MAX_LABEL_EDITS).default([]),
  })
  .refine((e) => e.add.length + e.remove.length > 0, "no label to change")
  .refine((e) => distinct([...e.add, ...e.remove]), "a label twice");
const draftBody = z.object({ ...pullRef, draft: z.boolean() });
const updateBranchBody = z.object({ ...pullRef, head: z.string().trim().toLowerCase().pipe(sha) });

const answer = (outcome: PullActionOutcome) => ({ outcome });

pullEdits.get("/labels", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = refQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const listing = await platform.edits.labels(token, ref.data.repo, ref.data.number);
  if (!listing) return apiError(c, "upstream_unreachable");
  return c.json({
    applied: listing.applied,
    available: listing.available.map((l) => ({
      name: l.name,
      color: l.color,
      description: l.description,
    })),
    truncated: listing.truncated,
  } satisfies PullLabelsView);
});

pullEdits.post(
  "/labels",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(labelsBody),
  async (c) => {
    const edit: PullLabelsRequest = c.req.valid("json");
    const reached = await reach(c, byKind(edit));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const outcome = await platform.edits.editLabels(token, edit.repo, edit.number, edit);
    if (!outcome) return apiError(c, "upstream_unreachable");
    if (outcome === "done") {
      await audit(c.var.data, "pull.labels_changed", {
        pull: `${edit.repo}#${edit.number}`,
        added: edit.add,
        removed: edit.remove,
      });
    }
    return c.json(answer(outcome));
  },
);

pullEdits.get("/draft", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = refQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const found = await platform.edits.draft(token, ref.data.repo, ref.data.number);
  if (!found) return apiError(c, "upstream_unreachable");
  return c.json({ draft: found.draft, state: found.state } satisfies PullDraftView);
});

pullEdits.post(
  "/draft",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(draftBody),
  async (c) => {
    const edit: PullDraftRequest = c.req.valid("json");
    const reached = await reach(c, byKind(edit));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const outcome = await platform.edits.setDraft(token, edit.repo, edit.number, edit.draft);
    if (!outcome) return apiError(c, "upstream_unreachable");
    if (outcome === "done") {
      const kind = edit.draft ? "pull.marked_draft" : "pull.marked_ready";
      await audit(c.var.data, kind, { pull: `${edit.repo}#${edit.number}` });
    }
    return c.json(answer(outcome === "unchanged" ? "done" : outcome));
  },
);

pullEdits.post(
  "/update-branch",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(updateBranchBody),
  async (c) => {
    const update: PullUpdateBranchRequest = c.req.valid("json");
    const reached = await reach(c, byKind(update));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const outcome = await platform.edits.updateBranch(
      token,
      update.repo,
      update.number,
      update.head,
    );
    if (!outcome) return apiError(c, "upstream_unreachable");
    if (outcome === "head_moved") return apiError(c, "stale");
    if (outcome === "updating") {
      const pull = `${update.repo}#${update.number}`;
      await audit(c.var.data, "pull.branch_updated", { pull, head: update.head });
    }
    return c.json({ outcome } satisfies PullUpdateBranchAnswer);
  },
);
