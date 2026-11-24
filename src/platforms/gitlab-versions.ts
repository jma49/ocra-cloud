import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { straightDiff } from "./gitlab-since.js";
import { platformCall } from "./http.js";
import type { PlatformVersion, PullVersions } from "./versions.js";

// GitLab keeps a version of a merge request's diff for every push
// (`/merge_requests/:iid/versions`), which is exactly its versions; it does
// not say which were force pushes. Two versions compare tree to tree.

/** The newest versions read. */
const PER_PAGE = 100;

type Version = { head_commit_sha: string; created_at: string };

export function gitlabVersions(origin: string): PullVersions {
  return {
    async list(token, fullName, number) {
      const listed = await platformCall<Version[]>(
        `${mergeRequestUrl(origin, fullName, number)}/versions?per_page=${PER_PAGE}`,
        { headers: gitlabHeaders(token) },
      );
      if (!Array.isArray(listed)) return null;
      const versions = listed.flatMap((v): PlatformVersion[] => {
        const at = Date.parse(v.created_at);
        if (typeof v.head_commit_sha !== "string" || !Number.isFinite(at)) return [];
        return [
          {
            head: v.head_commit_sha.toLowerCase(),
            pushedAt: new Date(at),
            at: new Date(at),
            rewrite: null,
          },
        ];
      });
      return { versions, fromStart: listed.length < PER_PAGE, namesRewrites: false };
    },
    trees: (token, fullName, from, to) => straightDiff(origin, token, fullName, from, to),
  };
}
