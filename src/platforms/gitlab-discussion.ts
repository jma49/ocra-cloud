import { z } from "zod";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { boundedBytes, platformRead } from "./http.js";
import { findingStarting } from "./threads.js";

/**
 * The first note of a merge request discussion: who wrote it and when, the
 * finding it is ocra's comment of, and whether the discussion is resolved
 * and by whom; never its text.
 */
export type DiscussionStart = {
  noteId: string;
  authorId: string;
  login: string;
  createdAt: string | null;
  system: boolean;
  /** The fingerprint its marker names, when it starts with one. */
  finding: string | null;
  /** Null for a discussion that cannot be resolved. */
  resolved: {
    resolved: boolean;
    by: { id: string; login: string } | null;
    at: string | null;
  } | null;
};

/** A discussion's answer read at most: its notes' text comes with it. */
const MAX_BYTES = 1024 * 1024;
const DISCUSSION_ID = /^[0-9a-f]{1,64}$/i;

const discussion = z.object({
  notes: z
    .array(
      z.object({
        id: z.number(),
        author: z.object({ id: z.number(), username: z.string() }),
        created_at: z.string().nullish(),
        system: z.boolean().nullish(),
        body: z.string().nullish(),
        resolvable: z.boolean().nullish(),
        resolved: z.boolean().nullish(),
        resolved_by: z.object({ id: z.number(), username: z.string() }).nullish(),
        resolved_at: z.string().nullish(),
      }),
    )
    .min(1),
});

/** One call, bounded in time and size and never retried; null when GitLab does not answer it. */
export async function gitlabDiscussionStart(
  origin: string,
  token: string,
  fullName: string,
  number: number,
  discussionId: string,
): Promise<DiscussionStart | null> {
  if (!DISCUSSION_ID.test(discussionId)) return null;
  const url = `${mergeRequestUrl(origin, fullName, number)}/discussions/${discussionId}`;
  const bytes = await platformRead(url, { headers: gitlabHeaders(token) }, (res) =>
    boundedBytes(res, MAX_BYTES),
  );
  if (!bytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const parsed = discussion.safeParse(json);
  const first = parsed.success ? parsed.data.notes[0] : undefined;
  if (!first) return null;
  return {
    noteId: String(first.id),
    authorId: String(first.author.id),
    login: first.author.username,
    createdAt: first.created_at ?? null,
    system: first.system === true,
    finding: findingStarting(first.body ?? "") ?? null,
    resolved: first.resolvable
      ? {
          resolved: first.resolved === true,
          by: first.resolved_by
            ? { id: String(first.resolved_by.id), login: first.resolved_by.username }
            : null,
          at: first.resolved_at ?? null,
        }
      : null,
  };
}
