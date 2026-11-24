import { Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.js";
import { apiError, jsonBody } from "./http.js";
import { shownLog } from "./platforms/ci-log.js";
import { byKind, pullRef, reach, sha } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import type { PullCiJob, PullCiLogView, PullCiRerunAnswer, PullCiView } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's CI panel, read and run again live as the signed-in user:
// the head's jobs, the end of a failed one's log, and a re-run of the
// failed jobs. Nothing of it is stored, and a log is never logged.

export const pullCi = new Hono<AppEnv>();

const jobId = z.string().regex(/^\d{1,20}$/);
const ciQuery = z.object(pullRef);
const logQuery = z.object({ ...pullRef, job: jobId });
const rerunBody = z.object({ ...pullRef, head: sha, job: jobId.optional() });

const jobDto = (j: PullCiJob) =>
  ({
    id: j.id,
    name: j.name,
    source: j.source,
    state: j.state,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    durationSeconds: j.durationSeconds,
    url: j.url,
    failedStep: j.failedStep,
    failureReason: j.failureReason,
    hasLog: j.hasLog,
    rerunnable: j.rerunnable,
  }) satisfies PullCiJob;

pullCi.get("/ci", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = ciQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const listed = await reached.platform.ci.jobs(reached.token, ref.data.repo, ref.data.number);
  if (!listed) return apiError(c, "upstream_unreachable");
  return c.json({
    platform: reached.platform.kind,
    repo: ref.data.repo,
    number: ref.data.number,
    head: listed.head,
    pipeline: listed.pipeline ? { id: listed.pipeline.id, url: listed.pipeline.url } : null,
    jobs: listed.jobs.map(jobDto),
    more: listed.more,
  } satisfies PullCiView);
});

pullCi.get("/ci/log", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = logQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const read = await reached.platform.ci.log(reached.token, ref.data.repo, ref.data.job);
  if (!read) return apiError(c, "not_found");
  const shown = read.source === "none" ? { log: "", redacted: false } : shownLog(read.text);
  c.header("cache-control", "no-store");
  return c.json({
    platform: reached.platform.kind,
    repo: ref.data.repo,
    number: ref.data.number,
    job: ref.data.job,
    name: read.name,
    url: read.url,
    source: read.source,
    log: shown.log,
    redacted: shown.redacted,
  } satisfies PullCiLogView);
});

pullCi.post(
  "/ci/rerun",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(rerunBody),
  async (c) => {
    const body = c.req.valid("json");
    const reached = await reach(c, byKind(body));
    if ("refusal" in reached) return reached.refusal;
    const done = await reached.platform.ci.rerun(
      reached.token,
      body.repo,
      body.number,
      body.head,
      body.job ?? null,
    );
    if (!done) return apiError(c, "upstream_unreachable");
    if (done.outcome === "rerun") {
      await audit(c.var.data, "pull.checks_rerun", {
        pull: `${body.repo}#${body.number}`,
        head: body.head,
        rerun: done.rerun,
      });
    }
    return c.json({ outcome: done.outcome, rerun: done.rerun } satisfies PullCiRerunAnswer);
  },
);
