import { Hono } from "hono";
import { z } from "zod";
import { apiError, jsonBody } from "./http.js";
import { chainTo, MAX_STACK, stackOf } from "./platforms/stacks.js";
import {
  byKind,
  mergeMethodsOf,
  mergeOne,
  methodNotAllowed,
  pullRef,
  reach,
  sha,
} from "./pull-page.js";
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
// and its merge from the bottom up to one of them (ADR-0052). Only the web
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
    const allowed = await mergeMethodsOf(platform, token, repo);
    if (!allowed.includes(method)) return methodNotAllowed(c);
    const open = await platform.stacks.open(token, repo);
    if (!open) return apiError(c, "upstream_unreachable");
    const stack = stackOf(open, number);
    if (!stack) return apiError(c, "not_found");
    const chain = chainTo(stack.pulls, number);
    // A stack that changed since the page read it is not merged on the page's word.
    const same =
      chain.length === heads.length && chain.every((p, i) => p.number === heads[i]?.number);
    if (!same) {
      return c.json({
        steps: [{ number, outcome: "head_moved" }],
        restacked: [],
      } satisfies StackMergeView);
    }
    const steps: StackMergeStep[] = [];
    for (const [i, pull] of chain.entries()) {
      const head = heads[i]?.head ?? "";
      const moved =
        i > 0 && pull.base !== stack.trunk
          ? await platform.stacks.retarget(token, repo, pull.number, stack.trunk)
          : "done";
      const outcome =
        moved === "done"
          ? await mergeOne(platform, token, { repo, number: pull.number, method, head }, allowed)
          : moved;
      steps.push({ number: pull.number, outcome: outcome ?? "unreached" });
      if (outcome !== "done") break;
    }
    // One stacked on a merged pull would otherwise merge into a branch that already landed.
    const landed = chain.filter((p) =>
      steps.some((s) => s.number === p.number && s.outcome === "done"),
    );
    const restacked: StackMergeStep[] = [];
    for (const pull of open) {
      const inChain = chain.some((p) => p.number === pull.number);
      if (inChain || !landed.some((p) => p.head === pull.base)) continue;
      const moved = await platform.stacks.retarget(token, repo, pull.number, stack.trunk);
      restacked.push({ number: pull.number, outcome: moved ?? "unreached" });
    }
    return c.json({ steps, restacked } satisfies StackMergeView);
  },
);
