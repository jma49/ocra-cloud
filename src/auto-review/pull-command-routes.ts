import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { apiError } from "../http.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import {
  MAX_PULL_COMMANDS,
  type PullCommandsView,
  type PullCommandView,
  type PullPauseView,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";

// An enrolled repository's pull request as `@ocra` commands left it
// (./commands.ts): its newest commands and its pause, which the console
// sets and lifts as `@ocra pause` and `@ocra resume` do, without a comment.

const number = z.coerce
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);

/** The account's repository and the pull request's number, or the refusal. */
async function pullOf(c: Context<AppEnv>) {
  const n = number.safeParse(c.req.param("number"));
  const repo = n.success ? await c.var.data.get("reviewRepos", c.req.param("id") ?? "") : undefined;
  if (!n.success || !repo) return { refusal: apiError(c, "not_found") } as const;
  return { repo, number: n.data, pull: `${repo.fullName}#${n.data}` } as const;
}

export function pullCommandRoute() {
  const route = new Hono<AppEnv>();

  route.get("/repos/:id/pulls/:number/commands", requireSession(), async (c) => {
    const found = await pullOf(c);
    if ("refusal" in found) return found.refusal;
    const commands = c.var.data.commands;
    const [paused, rows] = await Promise.all([
      commands.paused(found.repo.id, found.number),
      commands.newest(found.repo.id, found.number, MAX_PULL_COMMANDS),
    ]);
    return c.json({
      paused,
      commands: rows.map(
        (r) =>
          ({
            command: r.command,
            outcome: r.outcome,
            createdAt: r.createdAt.toISOString(),
            finishedAt: r.finishedAt?.toISOString() ?? null,
          }) satisfies PullCommandView,
      ),
    } satisfies PullCommandsView);
  });

  route.put(
    "/repos/:id/pulls/:number/pause",
    requireSession(["web"]),
    perMinute("settings"),
    async (c) => {
      const found = await pullOf(c);
      if ("refusal" in found) return found.refusal;
      if (await c.var.data.commands.pause(found.repo.id, found.number)) {
        await audit(c.var.data, "auto_review.pull_paused", { pull: found.pull });
      }
      return c.json({ paused: true } satisfies PullPauseView);
    },
  );

  route.delete(
    "/repos/:id/pulls/:number/pause",
    requireSession(["web"]),
    perMinute("settings"),
    async (c) => {
      const found = await pullOf(c);
      if ("refusal" in found) return found.refusal;
      if (await c.var.data.commands.resume(found.repo.id, found.number)) {
        await audit(c.var.data, "auto_review.pull_resumed", { pull: found.pull });
      }
      return c.json({ paused: false } satisfies PullPauseView);
    },
  );

  return route;
}
