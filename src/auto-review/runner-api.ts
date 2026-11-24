import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { sameText, sha256Hex } from "../crypto.js";
import { runnerSeen } from "../db/review-runners.js";
import type { GraphService } from "../graph/routes.js";
import { assignBuild, type GraphAssignment, graphRunnerApi } from "../graph/runner-api.js";
import { apiError, jsonBody } from "../http.js";
import type { BotTokens } from "../platforms/bot.js";
import { COMMIT_ID } from "../platforms/contents.js";
import { platformsOf } from "../platforms/registry.js";
import {
  assignRestack,
  type RestackAssignment,
  settleRestack,
} from "../stack-merge/restack-work.js";
import type { AppEnv } from "../types.js";
import { isAnswered, MAX_RUN_DETAIL, settleAnswered } from "./answers.js";
import {
  ANSWERED_KINDS,
  type Assignment,
  assign,
  RUN_FAILURES,
  settle,
  WORK_KINDS,
} from "./work.js";

// A remote runner's two calls (docs/runner.md): it asks for the next hosted
// job, which this server claims and prepares for it (./work.ts), runs it on
// its own machine (src/node/review-runner.ts) and reports how it went. It
// proves itself with the deployment's runner token and holds nothing else:
// each job brings a bot credential for its one repository and a session of
// the enrolling account, both ended with the job. A runner that builds code
// graphs is given a queued build when no job is due (src/graph/runner-api.ts).

export type RunnerAccess = { token: string; bots: BotTokens; graphs?: GraphService };

/** Jobs refused in a row (a repository or bot gone) before a claim answers none. */
const MAX_REFUSED = 3;

const hello = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(40),
  /** Whether it builds code graphs: one that does not is never given a build. */
  graphs: z.boolean().optional(),
  /** Whether it restacks: one from before restacks is never given one. */
  restack: z.boolean().optional(),
  /**
   * The answered kinds it runs and reports the answer of (ANSWERED_KINDS):
   * one never named is never given. A kind this server does not know is ignored.
   */
  answers: z.array(z.string().max(40)).max(20).optional(),
});

const jobRef = {
  id: z.string().min(1).max(100),
  accountId: z.string().min(1).max(100),
  attempts: z.number().int().min(1),
};

// An answered kind settles with its answer, at /settle-answer.
const detail = z.string().min(1).max(MAX_RUN_DETAIL).optional();
const outcome = z.object({
  kind: z.enum(WORK_KINDS).exclude(ANSWERED_KINDS),
  id: z.string().min(1).max(100),
  accountId: z.string().min(1).max(100),
  attempts: z.number().int().min(1),
  failure: z.enum(RUN_FAILURES).nullable(),
});

const answeredOutcome = z.object({
  kind: z.enum(ANSWERED_KINDS),
  ...jobRef,
  // Read with the kind's own schema by its settler (./answers.ts).
  ran: z.union([
    z.object({ answer: z.unknown().refine((a) => a !== undefined), detail }),
    z.object({ failure: z.enum(RUN_FAILURES), detail }),
  ]),
});

const SKIPPED_BY_RUN = ["up_to_date", "push_refused"] as const;
const restackOutcome = z.object({
  id: z.string().min(1).max(100),
  accountId: z.string().min(1).max(100),
  attempts: z.number().int().min(1),
  result: z.union([
    z.object({ outcome: z.literal("restacked"), head: z.string().regex(COMMIT_ID) }),
    z.object({ outcome: z.enum(["conflict", "lease_lost"]) }),
    z.object({ outcome: z.literal("skipped"), reason: z.enum(SKIPPED_BY_RUN) }),
    z.object({ failure: z.enum(RUN_FAILURES) }),
  ]),
});

const proven = (token: string): MiddlewareHandler<AppEnv> => {
  const expected = sha256Hex(token);
  return async (c, next) => {
    const given = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!sameText(await sha256Hex(given), await expected)) return apiError(c, "unauthenticated");
    await next();
  };
};

export function runnerApi(access: RunnerAccess) {
  const route = new Hono<AppEnv>().use(proven(access.token));

  route.post("/claim", jsonBody(hello), async (c) => {
    const { name, version, graphs, restack, answers } = c.req.valid("json");
    await runnerSeen(c.var.db, name, version, new Date());
    const source = {
      db: c.var.db,
      platforms: platformsOf(c.env, c.req.url),
      bots: access.bots,
      publicUrl: c.env.PUBLIC_URL ?? new URL(c.req.url).origin,
      dailyCalls: config(c.env).gatewayDailyCalls,
      ...(graphs && access.graphs ? { graphs: access.graphs } : {}),
    };
    for (const kind of WORK_KINDS) {
      if (isAnswered(kind) && !answers?.includes(kind)) continue;
      for (let refused = 0; refused < MAX_REFUSED; refused++) {
        const work = await assign(source, kind);
        if (!work) break;
        if (work !== "refused") return c.json({ assignment: work satisfies Assignment });
      }
    }
    if (restack) {
      for (let refused = 0; refused < MAX_REFUSED; refused++) {
        const work = await assignRestack(source);
        if (!work) break;
        if (work !== "refused") {
          return c.json({ assignment: null, restack: work satisfies RestackAssignment });
        }
      }
    }
    const graph = graphs && access.graphs?.remote ? await assignBuild(source) : undefined;
    return c.json({
      assignment: null,
      ...(graph ? { graph: graph satisfies GraphAssignment } : {}),
    });
  });

  route.post("/settle", jsonBody(outcome), async (c) => {
    const { failure, ...ref } = c.req.valid("json");
    // Recorded only while the job is still this attempt's, under its own account.
    await settle(
      { db: c.var.db, dailyCalls: config(c.env).gatewayDailyCalls },
      ref,
      failure,
      new Date(),
    );
    return c.json({ ok: true });
  });

  route.post("/settle-answer", jsonBody(answeredOutcome), async (c) => {
    const { ran, ...job } = c.req.valid("json");
    const source = {
      db: c.var.db,
      dailyCalls: config(c.env).gatewayDailyCalls,
      platforms: platformsOf(c.env, c.req.url),
      bots: access.bots,
    };
    const answered = {
      ...("failure" in ran ? { failure: ran.failure } : { answer: ran.answer }),
      ...(ran.detail ? { detail: ran.detail } : {}),
    };
    // Recorded only while the job is still this attempt's, under its own account.
    await settleAnswered(source, job, answered, new Date());
    return c.json({ ok: true });
  });

  route.post("/settle-restack", jsonBody(restackOutcome), async (c) => {
    const { result, ...ref } = c.req.valid("json");
    const source = { db: c.var.db, platforms: platformsOf(c.env, c.req.url), bots: access.bots };
    // Recorded only while the restack is still this attempt's, under its own account.
    await settleRestack(source, ref, result, new Date());
    return c.json({ ok: true });
  });

  if (access.graphs?.remote) route.route("/graphs", graphRunnerApi(access.graphs.remote));

  return route;
}
