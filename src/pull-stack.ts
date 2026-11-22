import { Hono } from "hono";
import { z } from "zod";
import { apiError, jsonBody } from "./http.js";
import { chainTo, MAX_STACK, stackOf } from "./platforms/stacks.js";
import { byKind, mergeOne, pullRef, reach, sha } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import {
  MERGE_METHODS,
  type PullStackView,
  type StackedPull,
  type StackMergeStep,
  type StackMergeView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's stack, read live from the platform as the signed-in user,
// and its merge from the bottom up to one of them (ADR-0051). Only the web
// session acts, as on the pull request's page.

export const pullStack = new Hono<AppEnv>();

const stackQuery = z.object(pullRef);
const mergeStackBody = z.object({
  ...pullRef,
  method: z.enum(MERGE_METHODS),
  /** The stack the page read, bottom to the requested one, each with the head it saw. */
  heads: z
    .array(z.object({ number: pullRef.number, head: sha }))
    .min(1)
    .max(MAX_STACK),
});

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
  return c.json({
    platform: reached.platform.kind,
    repo: ref.data.repo,
    number: ref.data.number,
    trunk: stack?.trunk ?? "",
    pulls: stack?.pulls.map(stackedDto) ?? [],
  } satisfies PullStackView);
});

pullStack.post(
  "/merge-stack",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(mergeStackBody),
  async (c) => {
    const { repo, number, method, heads } = c.req.valid("json");
    const reached = await reach(c, byKind(c.req.valid("json")));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const open = await platform.stacks.open(token, repo);
    if (!open) return apiError(c, "upstream_unreachable");
    const stack = stackOf(open, number);
    if (!stack) return apiError(c, "not_found");
    const chain = chainTo(stack.pulls, number);
    const steps: StackMergeStep[] = [];
    const stop = (step: StackMergeStep) =>
      c.json({ steps: [...steps, step] } satisfies StackMergeView);
    // A stack that changed since the page read it is not merged on the page's word.
    const same =
      chain.length === heads.length && chain.every((p, i) => p.number === heads[i]?.number);
    if (!same) return stop({ number, outcome: "head_moved" });
    for (const [i, pull] of chain.entries()) {
      if (i > 0 && pull.base !== stack.trunk) {
        const moved = await platform.stacks.retarget(token, repo, pull.number, stack.trunk);
        if (moved !== "done") return stop({ number: pull.number, outcome: moved ?? "unreached" });
      }
      const head = heads[i]?.head ?? "";
      const merged = await mergeOne(platform, token, { repo, number: pull.number, method, head });
      if (merged !== "done") return stop({ number: pull.number, outcome: merged ?? "unreached" });
      steps.push({ number: pull.number, outcome: "done" });
    }
    return c.json({ steps } satisfies StackMergeView);
  },
);
