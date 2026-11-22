import { GENERATE_KINDS } from "@open-cr-agent/cloud-contract";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import { CODE_PLATFORMS, type GenerateJobView } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import type { AutoReviewService } from "./routes.js";

// Tests or docstrings for a pull request of a repository the account enrolled,
// written by `ocra generate` in the runner and committed to its branch as the
// bot. Enrolling proved the account reaches the repository; the CLI reads the
// pull request itself and refuses a branch it cannot push to.

const pullRef = {
  platform: z.enum(CODE_PLATFORMS),
  repo: z.string().min(1).max(400),
  number: z.coerce
    .number()
    .int()
    .min(1)
    .max(2 ** 31 - 1),
};
const listQuery = z.object(pullRef);
const generateBody = z.object({
  ...pullRef,
  head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  kind: z.enum(GENERATE_KINDS),
});

const jobView = (j: Row<"generateJobs">) =>
  ({
    kind: j.kind,
    head: j.head,
    state: j.state,
    error: j.error,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  }) satisfies GenerateJobView;

/** The account's enrolled repository the pull request is in, if any. */
async function enrolled(c: Context<AppEnv>, ref: z.output<typeof listQuery>) {
  const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === ref.platform);
  if (!platform) return undefined;
  return c.var.data.findOne("reviewRepos", {
    platform: platform.kind,
    host: platform.host,
    fullName: ref.repo,
  });
}

export function generateRoute(service: AutoReviewService) {
  const route = new Hono<AppEnv>();

  route.get("/", requireSession(["web"]), async (c) => {
    const ref = listQuery.safeParse(c.req.query());
    if (!ref.success) return apiError(c, "not_found");
    const repo = await enrolled(c, ref.data);
    if (!repo) return c.json({ enrolled: false, jobs: [] });
    const jobs = await c.var.data.generations.forPull(repo.id, ref.data.number);
    return c.json({ enrolled: true, jobs: jobs.map(jobView) });
  });

  route.post(
    "/",
    requireSession(["web"]),
    perMinute("platform"),
    jsonBody(generateBody),
    async (c) => {
      const body = c.req.valid("json");
      const repo = await enrolled(c, body);
      if (!repo) return apiError(c, "not_found");
      const queued = await c.var.data.generations.queue(repo.id, body.number, body.head, body.kind);
      if (queued) service.kick();
      return c.json({ queued });
    },
  );

  return route;
}
