import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import type { MergeIntent } from "../db/merge-intents.js";
import { apiError, jsonBody } from "../http.js";
import { publicOutbox } from "../notify/notify.js";
import type { CodePlatform } from "../platforms/platform.js";
import { platformsOf } from "../platforms/registry.js";
import { byKind, mergeMethodsOf, methodNotAllowed, pullRef, reach, sha } from "../pull-page.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import {
  MERGE_METHODS,
  type MergeIntentView,
  type MergeWhenReadyAnswer,
  type MergeWhenReadyOutcome,
  type MergeWhenReadyView,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { advance, type MergeRunner } from "./advance.js";

// Merge when ready, armed and cancelled from the pull request's page as the
// signed-in user: the platform's own auto-merge first; where the repository
// has it off, an intent this server keeps, on a repository this account
// enrolled (its webhooks move the intent) on a host that runs that work.

export const mergeWhenReady = new Hono<AppEnv>();

const refQuery = z.object(pullRef);
const armBody = z.object({
  ...pullRef,
  method: z.enum(MERGE_METHODS),
  head: sha,
  keepOnPush: z.boolean().default(false),
});
const cancelBody = z.object(pullRef);

const intentView = (i: MergeIntent) =>
  ({
    mode: i.mode,
    method: i.method,
    head: i.head,
    keepOnPush: i.keepOnPush,
    state: i.state,
    reason: i.reason,
    armedBy: i.armedBy,
    armedAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    finishedAt: i.finishedAt?.toISOString() ?? null,
  }) satisfies MergeIntentView;

/** The work a request's webhooks or page hand to advance(). */
export const runnerOf = (c: Context<AppEnv>): MergeRunner => ({
  db: c.var.db,
  env: c.env,
  platforms: platformsOf(c.env, c.req.url),
  out: publicOutbox(c),
});

/** The repository as this account enrolled it, where this host moves intents on its webhooks. */
async function serverRepo(c: Context<AppEnv>, platform: CodePlatform, fullName: string) {
  if (!c.var.autoReview) return undefined;
  return c.var.data.mergeChecks.enrolledRepo(platform.kind, platform.host, fullName);
}

const answer = (
  c: Context<AppEnv>,
  outcome: MergeWhenReadyOutcome,
  intent: MergeIntent | undefined | null,
) => c.json({ outcome, intent: intent ? intentView(intent) : null } satisfies MergeWhenReadyAnswer);

mergeWhenReady.get("/", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = refQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const platform = platformsOf(c.env, c.req.url).find(byKind(ref.data));
  if (!platform) return apiError(c, "not_found");
  const key = { platform: platform.kind, host: platform.host, fullName: ref.data.repo };
  const intent = await c.var.data.mergeIntents.of(key, ref.data.number);
  const server = (await serverRepo(c, platform, ref.data.repo)) !== undefined;
  return c.json({
    intent: intent ? intentView(intent) : null,
    server,
  } satisfies MergeWhenReadyView);
});

mergeWhenReady.post(
  "/",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(armBody),
  async (c) => {
    const body = c.req.valid("json");
    const reached = await reach(c, byKind(body));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    if (!(await mergeMethodsOf(platform, token, body.repo)).includes(body.method)) {
      return methodNotAllowed(c);
    }
    const data = c.var.data;
    const native = await platform.autoMerge.enable(token, body.repo, body.number, body);
    if (native === null) return apiError(c, "upstream_unreachable");
    const repo = await serverRepo(c, platform, body.repo);
    const fallback = (native === "unavailable" || native === "ready") && repo;
    if (native !== "done" && !fallback) return answer(c, native, null);
    const now = new Date();
    const intent = await data.mergeIntents.arm(
      {
        platform: platform.kind,
        host: platform.host,
        fullName: body.repo,
        number: body.number,
        method: body.method,
        mode: native === "done" ? "native" : "server",
        head: body.head,
        keepOnPush: body.keepOnPush,
        armedBy: c.var.session.account.login,
      },
      now,
    );
    if (!intent) return apiError(c, "internal");
    if (intent.state === "merging") return answer(c, "merging", intent);
    await audit(data, "merge_when_ready.armed", {
      pull: `${intent.fullName}#${intent.number}`,
      mode: intent.mode,
      method: intent.method,
      head: intent.head,
      keepOnPush: intent.keepOnPush,
    });
    if (intent.mode === "native" || !repo) return answer(c, "done", intent);
    // It may be ready already: tried now, as the webhooks would.
    const scope = { runner: runnerOf(c), data, platform, repo };
    return answer(c, "done", await advance(scope, intent, now));
  },
);

mergeWhenReady.delete(
  "/",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(cancelBody),
  async (c) => {
    const body = c.req.valid("json");
    const data = c.var.data;
    const platform = platformsOf(c.env, c.req.url).find(byKind(body));
    if (!platform) return apiError(c, "not_found");
    const key = { platform: platform.kind, host: platform.host, fullName: body.repo };
    const intent = await data.mergeIntents.of(key, body.number);
    if (!intent || (intent.state !== "armed" && intent.state !== "merging")) {
      return answer(c, "done", intent);
    }
    if (intent.state === "merging") return answer(c, "merging", intent);
    if (intent.mode === "native") {
      const reached = await reach(c, byKind(body));
      if ("refusal" in reached) return reached.refusal;
      const off = await platform.autoMerge.disable(reached.token, body.repo, body.number);
      if (off === null) return apiError(c, "upstream_unreachable");
      if (off !== "done") return answer(c, off, intent);
    }
    const cancelled = { state: "cancelled" as const, reason: null };
    if (await data.mergeIntents.settle(intent.id, intent.head, cancelled, new Date())) {
      await audit(data, "merge_when_ready.cancelled", {
        pull: `${intent.fullName}#${intent.number}`,
        mode: intent.mode,
      });
    }
    const now = await data.mergeIntents.of(key, body.number);
    return answer(c, now?.state === "merging" ? "merging" : "done", now);
  },
);
