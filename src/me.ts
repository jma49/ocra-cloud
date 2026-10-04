import { Hono } from "hono";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// Who is signed in, and with which kind of session.

export const me = new Hono<AppEnv>().use(requireSession(["web", "cli"]));

me.get("/", (c) => {
  const { account: a, kind } = c.var.session;
  return c.json({ login: a.login, githubId: a.githubId, session: kind, since: a.createdAt });
});
