import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import type { StackMerge } from "../db/stack-merges.js";
import { apiError, jsonBody } from "../http.js";
import { platformsOf } from "../platforms/registry.js";
import { MAX_STACK, stackOf } from "../platforms/stacks.js";
import { byKind, mergeMethodsOf, methodNotAllowed, pullRef, reach, sha } from "../pull-page.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import {
  chainTo,
  MERGE_METHODS,
  type StackMergeAnswer,
  type StackMergeJobView,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { advanceStack, type StackRunner } from "./advance.js";

// A stack's merge from the bottom up to one of its pull requests, started,
// watched and cancelled from the pull request's page as the signed-in user.
// The server runs it layer by layer (./advance.ts); a merge is named by the
// stack's bottom, and one runs per bottom at a time.

export const stackMerge = new Hono<AppEnv>();

const startBody = z.object({
  ...pullRef,
  method: z.enum(MERGE_METHODS),
  /** The stack the page read, bottom to the requested one, each with the head it saw. */
  heads: z
    .array(z.object({ number: pullRef.number, head: sha }))
    .min(1)
    .max(MAX_STACK),
});
/** `number` is the stack's bottom. */
const bottomRef = z.object(pullRef);

/** A status read moves a waiting merge on itself once the webhooks and the sweep have left it this long. */
const READ_IDLE_MS = 15_000;

const jobView = (m: StackMerge, platform: StackMergeJobView["platform"]) =>
  ({
    id: m.id,
    platform,
    repo: m.path,
    bottom: m.bottom,
    trunk: m.trunk,
    method: m.method,
    chain: m.chain.map((l) => ({ number: l.number, head: l.head })),
    step: m.step,
    state: m.state,
    reason: m.reason,
    restacked: m.restacked.map((s) => ({ number: s.number, outcome: s.outcome })),
    startedBy: m.startedBy,
    startedAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    finishedAt: m.finishedAt?.toISOString() ?? null,
  }) satisfies StackMergeJobView;

const runnerOf = (c: Context<AppEnv>): StackRunner => ({
  db: c.var.db,
  env: c.env,
  platforms: platformsOf(c.env, c.req.url),
});

const answer = (
  c: Context<AppEnv>,
  outcome: StackMergeAnswer["outcome"],
  merge: StackMerge | undefined,
) =>
  c.json({
    outcome,
    job: merge ? jobView(merge, merge.platform) : null,
  } satisfies StackMergeAnswer);

stackMerge.get("/", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = bottomRef.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const platform = platformsOf(c.env, c.req.url).find(byKind(ref.data));
  if (!platform) return apiError(c, "not_found");
  const key = { platform: platform.kind, host: platform.host, fullName: ref.data.repo };
  const data = c.var.data;
  const merge = await data.stackMerges.of(key, ref.data.number);
  const now = new Date();
  const idle =
    merge?.state === "waiting" && now.getTime() - merge.updatedAt.getTime() > READ_IDLE_MS;
  if (!merge || !idle) return answer(c, "done", merge);
  return answer(c, "done", await advanceStack({ runner: runnerOf(c), data, platform }, merge, now));
});

stackMerge.post(
  "/",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(startBody),
  async (c) => {
    const { repo, number, method, heads } = c.req.valid("json");
    const reached = await reach(c, byKind(c.req.valid("json")));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    if (!(await mergeMethodsOf(platform, token, repo)).includes(method)) return methodNotAllowed(c);
    const open = await platform.stacks.open(token, repo);
    if (!open) return apiError(c, "upstream_unreachable");
    const stack = stackOf(open, number);
    if (!stack) return apiError(c, "not_found");
    const chain = chainTo(stack.pulls, number);
    // A stack that changed since the page read it is not merged on the page's word.
    const same =
      chain.length === heads.length && chain.every((p, i) => p.number === heads[i]?.number);
    const bottom = chain[0];
    if (!same || !bottom) return answer(c, "stack_changed", undefined);
    const data = c.var.data;
    const now = new Date();
    const merge = await data.stackMerges.start(
      {
        platform: platform.kind,
        host: platform.host,
        fullName: repo,
        bottom: bottom.number,
        trunk: stack.trunk,
        method,
        chain: heads.map((h) => ({ number: h.number, head: h.head })),
        startedBy: c.var.session.account.login,
      },
      now,
    );
    if (!merge) return apiError(c, "internal");
    // Another merge of the stack holds the row: it is the one answered.
    if (merge.createdAt.getTime() !== now.getTime() || merge.state !== "waiting") {
      return answer(c, "running", merge);
    }
    await audit(data, "stack_merge.started", {
      pull: `${merge.path}#${merge.bottom}`,
      top: number,
      method,
    });
    // The bottom may merge now: tried at once, as the webhooks would.
    const runner = runnerOf(c);
    return answer(c, "started", await advanceStack({ runner, data, platform }, merge, now));
  },
);

stackMerge.delete(
  "/",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(bottomRef),
  async (c) => {
    const ref = c.req.valid("json");
    const platform = platformsOf(c.env, c.req.url).find(byKind(ref));
    if (!platform) return apiError(c, "not_found");
    const key = { platform: platform.kind, host: platform.host, fullName: ref.repo };
    const data = c.var.data;
    const merge = await data.stackMerges.of(key, ref.number);
    if (merge && (await data.stackMerges.cancel(merge.id, new Date()))) {
      const top = merge.chain[merge.chain.length - 1]?.number ?? merge.bottom;
      await audit(data, "stack_merge.cancelled", {
        pull: `${merge.path}#${merge.bottom}`,
        top,
        method: merge.method,
      });
    }
    return answer(c, "done", await data.stackMerges.of(key, ref.number));
  },
);
