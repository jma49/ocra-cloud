import { z } from "zod";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformJson } from "./http.js";
import { type CommentReactions, MAX_REACTION_COMMENTS, type Reactions } from "./reactions.js";

// GitLab's award emoji of a merge request's note, one call per note: no
// listing of notes carries them. thumbsup and thumbsdown are 👍 and 👎.

/** Awards one call reads: a note given more is counted to here. */
const PER_PAGE = 100;
const MAX_BYTES = 256 * 1024;
const NOTE_ID = /^\d{1,20}$/;

const awards = z.array(z.object({ name: z.string() }));

export function gitlabReactions(origin: string): CommentReactions {
  return {
    async read(token, fullName, number, commentIds, calls) {
      const found = new Map<string, Reactions>();
      const ids = [...new Set(commentIds)].filter((id) => NOTE_ID.test(id));
      const url = mergeRequestUrl(origin, fullName, number);
      let failed = 0;
      for (const id of ids.slice(0, MAX_REACTION_COMMENTS)) {
        if (calls && !calls.has()) return found.size > 0 ? found : "spent";
        const answer = await platformJson<unknown>(
          `${url}/notes/${id}/award_emoji?per_page=${PER_PAGE}`,
          { headers: gitlabHeaders(token) },
          MAX_BYTES,
        );
        const list = answer?.status === 200 ? awards.safeParse(answer.body).data : undefined;
        if (!list) {
          failed++;
          continue;
        }
        found.set(id, {
          up: list.filter((a) => a.name === "thumbsup").length,
          down: list.filter((a) => a.name === "thumbsdown").length,
        });
      }
      return failed > 0 && found.size === 0 ? null : found;
    },
  };
}
