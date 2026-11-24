import { z } from "zod";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformJson } from "./http.js";
import type { CommentReactions, Reactions } from "./reactions.js";

// GitHub counts a review comment's reactions in the comment itself, so one
// listing of the pull request's review comments reads all of ocra's: a
// hundred a page, oldest first, until every one asked for is found.

const PER_PAGE = 100;
/** Pages read at most: ocra's comments come with the review, early in the listing. */
const MAX_PAGES = 3;
/** A page's answer read at most: comments carry their text and diff hunk. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

const page = z.array(
  z.object({
    id: z.number(),
    reactions: z.object({ "+1": z.number().int().min(0), "-1": z.number().int().min(0) }).nullish(),
  }),
);

export function githubReactions(host: Pick<GithubHost, "api">): CommentReactions {
  return {
    async read(token, fullName, number, commentIds, calls) {
      const wanted = new Set(commentIds);
      const found = new Map<string, Reactions>();
      if (wanted.size === 0) return found;
      const base = `${host.api}/repos/${githubRepoPath(fullName)}/pulls/${number}/comments`;
      for (let p = 1; p <= MAX_PAGES && found.size < wanted.size; p++) {
        if (calls && !calls.has()) return found.size > 0 ? found : "spent";
        const answer = await platformJson<unknown>(
          `${base}?per_page=${PER_PAGE}&page=${p}&sort=created&direction=asc`,
          { headers: githubHeaders(token) },
          MAX_PAGE_BYTES,
        );
        const comments = answer?.status === 200 ? page.safeParse(answer.body).data : undefined;
        if (!comments) return p === 1 ? null : found;
        for (const c of comments) {
          const id = String(c.id);
          if (wanted.has(id) && c.reactions) {
            found.set(id, { up: c.reactions["+1"], down: c.reactions["-1"] });
          }
        }
        if (comments.length < PER_PAGE) break;
      }
      return found;
    },
  };
}
