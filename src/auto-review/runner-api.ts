import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { sameText, sha256Hex } from "../crypto.js";
import { runnerSeen } from "../db/review-runners.js";
import { apiError, jsonBody } from "../http.js";
import type { BotTokens } from "../platforms/bot.js";
import { platformsOf } from "../platforms/registry.js";
import type { AppEnv } from "../types.js";
import { type Assignment, assign, RUN_FAILURES, settle, WORK_KINDS } from "./work.js";

// A remote runner's two calls (docs/runner.md): it asks for the next hosted
// job, which this server claims and prepares for it (./work.ts), runs it on
// its own machine (src/node/review-runner.ts) and reports how it went. It
// proves itself with the deployment's runner token and holds nothing else:
// each job brings a bot credential for its one repository and a session of
// the enrolling account, both ended with the job.

export type RunnerAccess = { token: string; bots: BotTokens };

/** Jobs refused in a row (a repository or bot gone) before a claim answers none. */
const MAX_REFUSED = 3;

const hello = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(40),
});

const outcome = z.object({
  kind: z.enum(WORK_KINDS),
  id: z.string().min(1).max(100),
  accountId: z.string().min(1).max(100),
  attempts: z.number().int().min(1),
  failure: z.enum(RUN_FAILURES).nullable(),
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
    const { name, version } = c.req.valid("json");
    await runnerSeen(c.var.db, name, version, new Date());
    const source = {
      db: c.var.db,
      platforms: platformsOf(c.env, c.req.url),
      bots: access.bots,
      publicUrl: c.env.PUBLIC_URL ?? new URL(c.req.url).origin,
    };
    for (const kind of WORK_KINDS) {
      for (let refused = 0; refused < MAX_REFUSED; refused++) {
        const work = await assign(source, kind);
        if (!work) break;
        if (work !== "refused") return c.json({ assignment: work satisfies Assignment });
      }
    }
    return c.json({ assignment: null });
  });

  route.post("/settle", jsonBody(outcome), async (c) => {
    const { failure, ...ref } = c.req.valid("json");
    // Recorded only while the job is still this attempt's, under its own account.
    await settle(c.var.db, ref, failure, new Date());
    return c.json({ ok: true });
  });

  return route;
}
