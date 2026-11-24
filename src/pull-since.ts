import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "./http.js";
import type { PatchedFile } from "./platforms/changes.js";
import type { SinceDiff } from "./platforms/since.js";
import { byKind, pullRef, reach, sha } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import type {
  PullFileView,
  PullSinceOption,
  PullSinceState,
  PullSinceView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// What changed in a pull request since the head the user last reviewed or
// saw: the diff from that head to the current one, read live as the user.
// Nothing read is stored.

export const pullSince = new Hono<AppEnv>();

/** A sha as a link or a hand writes it: any case, spaces around. */
export const shaOf = z.string().max(80).trim().toLowerCase().pipe(sha);
const sinceQuery = z.object({ ...pullRef, since: shaOf.optional() });

const isSha = (s: string | null | undefined): s is string => sha.safeParse(s).success;

/** A compared file in the page's shape; whether it is viewed, the full page's files say. */
export const fileView = (f: PatchedFile): PullFileView => ({
  path: f.path,
  oldPath: f.oldPath,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  patch: f.patch,
  viewed: null,
});

const stateOf = (diff: SinceDiff | null): PullSinceState => diff?.state ?? "unavailable";

pullSince.get("/since", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = sinceQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const { repo, number } = ref.data;
  const [pull, reviewed, [seen]] = await Promise.all([
    platform.changes.changes(token, repo, number, 0),
    platform.since.reviewed(token, repo, number),
    c.var.data.pullSeen.markers([{ platform: platform.kind, repo: repo.toLowerCase(), number }]),
  ]);
  if (!pull) return apiError(c, "not_found");
  // Platform answers and the read mark alike are checked before they go into a URL.
  const options: PullSinceOption[] = [];
  if (reviewed && isSha(reviewed.head)) {
    options.push({ source: "reviewed", head: reviewed.head, at: reviewed.at });
  }
  if (seen && isSha(seen.head)) {
    options.push({ source: "seen", head: seen.head, at: new Date(seen.seenAt).toISOString() });
  }
  const since = ref.data.since ?? options[0]?.head ?? null;
  const diff =
    since === null || since === pull.head
      ? null
      : await platform.since.diff(token, repo, since, pull.head);
  const state = since === null ? "none" : since === pull.head ? "same" : stateOf(diff);
  const changed = diff?.state === "changes" ? diff : null;
  return c.json({
    platform: platform.kind,
    repo,
    number,
    head: pull.head,
    since,
    state,
    options,
    files: (changed?.files ?? []).map(fileView),
    truncated: changed?.truncated ?? false,
  } satisfies PullSinceView);
});
