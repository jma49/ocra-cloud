import { cloudModelSchema, redact } from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import { z } from "zod";
import { chatModelOf, completeChat } from "./chat/call.js";
import { explainPrompt } from "./chat/ci-prompt.js";
import { makeNonce } from "./chat/prompt.js";
import { apiError, jsonBody } from "./http.js";
import { shownLog } from "./platforms/ci-log.js";
import { byKind, pullRef, reach } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import { formatModelId, type PullCiExplainView } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// "Explain this failure": the account's own model reads the end of a failed
// CI job's log, read now as the user, and the pull request's changed paths,
// and says why the job failed and what to look at. It writes no patch and
// runs nothing; the explanation is not kept, and neither the log nor the
// answer is logged. The call counts against the gateway's daily cap.

export const pullCiExplain = new Hono<AppEnv>();

const MAX_EXPLANATION = 4_000;
const MAX_PATHS = 100;

const explainBody = z.object({
  ...pullRef,
  job: z.string().regex(/^\d{1,20}$/),
  model: cloudModelSchema.optional(),
});

pullCiExplain.post(
  "/ci/explain",
  requireSession(["web"]),
  perMinute("gateway"),
  jsonBody(explainBody),
  async (c) => {
    const body = c.req.valid("json");
    const reached = await reach(c, byKind(body));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const read = await platform.ci.log(token, body.repo, body.job);
    if (!read) return apiError(c, "not_found");
    const answer = (explanation: string | null, model: string | null, redacted = false) =>
      c.json({
        job: body.job,
        name: read.name,
        url: read.url,
        source: read.source,
        model,
        explanation,
        redacted,
      } satisfies PullCiExplainView);
    if (read.source === "none") return answer(null, null);

    const model = await chatModelOf(c, body.model);
    if ("refusal" in model) return model.refusal;
    const changes = await platform.changes.changes(token, body.repo, body.number, MAX_PATHS);
    const { system, question } = explainPrompt(
      {
        repo: body.repo,
        number: body.number,
        name: read.name,
        source: read.source,
        log: shownLog(read.text).log,
        paths: changes ? changes.files.map((f) => f.path) : null,
      },
      makeNonce(),
    );
    c.header("cache-control", "no-store");
    const done = await completeChat(
      c,
      model,
      system,
      [{ role: "user", text: question }],
      MAX_EXPLANATION,
    );
    if ("refusal" in done) return done.refusal;
    const shown = redact(done.text.trim());
    return answer(shown.text, formatModelId(model.ref.provider, model.ref.model), shown.redacted);
  },
);
