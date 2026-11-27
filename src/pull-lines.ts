import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "./http.js";
import { byKind, reach } from "./pull-page.js";
import { pullRef, sha } from "./pull-ref.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import type { PullLinesView } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// Unchanged lines of a pull request's file, read live as the user at the
// head the page shows, so its diff can open what the platform left out
// around a hunk. Nothing read is stored.

export const pullLines = new Hono<AppEnv>();

/** Past this a file is not read for its lines. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Lines one answer carries at most. */
const MAX_LINES = 1000;

/** A path inside the repository: no empty, `.` or `..` part, no leading slash. */
const repoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.split("/").every((part) => part !== "" && part !== "." && part !== ".."), {
    message: "not a path inside the repository",
  });
const line = z.coerce.number().int().min(1).max(10_000_000);
const linesQuery = z
  .object({ ...pullRef, head: sha, path: repoPath, from: line, to: line })
  .refine((q) => q.to >= q.from && q.to - q.from < MAX_LINES);

pullLines.get("/lines", requireSession(["web"]), perMinute("platform"), async (c) => {
  const query = linesQuery.safeParse(c.req.query());
  if (!query.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(query.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const { repo, head, path, from, to } = query.data;
  const where = await platform.contents.head(token, repo);
  if (!where) return apiError(c, "not_found");
  const read = await platform.files.read(
    token,
    { platformRepoId: where.platformRepoId, fullName: where.fullName },
    head,
    [path],
    MAX_FILE_BYTES,
  );
  if (!read) return apiError(c, "upstream_unreachable");
  const file = read[0];
  if (!file || file.blobId === null) return apiError(c, "not_found");
  if (!file.bytes)
    return c.json({ path, head, from, lines: null, total: null } satisfies PullLinesView);
  const all = new TextDecoder().decode(file.bytes).split("\n");
  // A file's last newline ends its last line; it does not start another.
  if (all.at(-1) === "") all.pop();
  return c.json({
    path,
    head,
    from,
    lines: all.slice(from - 1, to).map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)),
    total: all.length,
  } satisfies PullLinesView);
});
