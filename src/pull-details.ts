import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.js";
import { apiError, jsonBody } from "./http.js";
import type { EditOutcome } from "./platforms/edits.js";
import { byKind, pullRef, reach } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TITLE_CHARS,
  PULL_OPENNESS,
  type PullActionOutcome,
  type PullDetailsRequest,
  type PullStateRequest,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's title and description edited, and the pull request
// closed or reopened, from its page as the signed-in user. Nothing read or
// sent is kept but the audit entry, which names the fields, never their text.

export const pullDetails = new Hono<AppEnv>();

/** One line: a title has no line breaks or control characters, and is not blank. */
const title = z
  .string()
  .max(MAX_TITLE_CHARS)
  .refine((t) => !/\p{Cc}/u.test(t), "not a title");
const newTitle = title.refine((t) => t.trim() !== "", "an empty title");
const body = z.string().max(MAX_DESCRIPTION_CHARS);

const detailsBody = z
  .object({
    ...pullRef,
    title: z.object({ from: title, to: newTitle }).optional(),
    body: z.object({ from: body, to: body }).optional(),
  })
  .refine((e) => e.title !== undefined || e.body !== undefined, "nothing to change");
const stateBody = z.object({ ...pullRef, state: z.enum(PULL_OPENNESS) });

/** A platform's 404 and 409 as the refusals they are; its other refusals as `refused`. */
function answer(c: Context<AppEnv>, outcome: EditOutcome | null) {
  if (!outcome) return apiError(c, "upstream_unreachable");
  if (outcome === "not_found") return apiError(c, "not_found");
  if (outcome === "stale") return apiError(c, "stale");
  return c.json({
    outcome: outcome === "unchanged" ? "done" : outcome,
  } satisfies { outcome: PullActionOutcome });
}

pullDetails.post(
  "/details",
  requireSession(["web"]),
  perMinute("platform"),
  // A character is at most 6 bytes in JSON (\u escapes), twice for from and to.
  jsonBody(detailsBody, { max: MAX_DESCRIPTION_CHARS * 12 + 8192 }),
  async (c) => {
    const edit: PullDetailsRequest = c.req.valid("json");
    const reached = await reach(c, byKind(edit));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const outcome = await platform.edits.editDetails(token, edit.repo, edit.number, edit);
    if (outcome === "done") {
      const fields = (["title", "body"] as const).filter((f) => edit[f] !== undefined);
      await audit(c.var.data, "pull.details_edited", {
        pull: `${edit.repo}#${edit.number}`,
        fields,
      });
    }
    return answer(c, outcome);
  },
);

pullDetails.post(
  "/state",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(stateBody),
  async (c) => {
    const edit: PullStateRequest = c.req.valid("json");
    const reached = await reach(c, byKind(edit));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const outcome = await platform.edits.setOpenness(token, edit.repo, edit.number, edit.state);
    if (outcome === "done") {
      const kind = edit.state === "closed" ? "pull.closed" : "pull.reopened";
      await audit(c.var.data, kind, { pull: `${edit.repo}#${edit.number}` });
    }
    return answer(c, outcome);
  },
);
