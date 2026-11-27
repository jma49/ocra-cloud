import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "./http.js";
import { stackOf, withBehind } from "./platforms/stacks.js";
import { byKind, reach } from "./pull-page.js";
import { pullRef } from "./pull-ref.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import type { PullStackView, StackedPull } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's stack, read live from the platform as the signed-in user
// (ADR-0052); its merge is a job the server runs (./stack-merge/routes.ts).

export const pullStack = new Hono<AppEnv>();

const stackQuery = z.object(pullRef);
const stackedDto = (p: StackedPull) =>
  ({
    number: p.number,
    title: p.title,
    url: p.url,
    draft: p.draft,
    head: p.head,
    base: p.base,
    headSha: p.headSha,
    parent: p.parent,
    behind: p.behind,
    checks: p.checks,
    review: p.review,
  }) satisfies StackedPull;

pullStack.get("/stack", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = stackQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const open = await reached.platform.stacks.open(reached.token, ref.data.repo);
  if (!open) return apiError(c, "upstream_unreachable");
  const stack = stackOf(open, ref.data.number);
  const pulls = stack
    ? await withBehind(reached.platform.stacks, reached.token, ref.data.repo, stack.pulls)
    : [];
  return c.json({
    platform: reached.platform.kind,
    repo: ref.data.repo,
    number: ref.data.number,
    trunk: stack?.trunk ?? "",
    pulls: pulls.map(stackedDto),
  } satisfies PullStackView);
});
