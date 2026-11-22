import { Hono } from "hono";
import { githubIdOf } from "./db/accounts.js";
import { requireSession } from "./session.js";
import type { GraphPolicy } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// Who is signed in, with which kind of session, and what this deployment offers them.

export function meRoute(codeGraphs: GraphPolicy) {
  const me = new Hono<AppEnv>().use(requireSession(["web", "cli"]));
  me.get("/", async (c) => {
    const { account: a, kind } = c.var.session;
    const githubId = await githubIdOf(c.var.db, a.id);
    return c.json({ login: a.login, githubId, session: kind, since: a.createdAt, codeGraphs });
  });
  return me;
}
