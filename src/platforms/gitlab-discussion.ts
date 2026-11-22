import { z } from "zod";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { boundedBytes, platformRead } from "./http.js";

/** The first note of a merge request discussion: who wrote it and when, never its text. */
export type DiscussionStart = {
  noteId: string;
  authorId: string;
  login: string;
  createdAt: string | null;
  system: boolean;
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
  };
}
