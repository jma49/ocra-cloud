import { z } from "zod";
import { gitlabHeaders } from "./gitlab-changes.js";
import { boundedBytes, platformRead } from "./http.js";

// The GitLab groups a user maintains, and a group's newest projects, its
// subgroups' included: what enrolling a group's new projects reads
// (src/auto-review/group-sweep.ts). Each call is one page, bounded in size.

const PER_PAGE = 100;
/** Pages of the user's groups read at most. */
export const GROUP_PAGES = 3;
const MAX_BYTES = 1024 * 1024;
/** Maintainer: the role that may add a project's hook. */
const MAINTAINER = 40;

const groups = z.array(
  z.object({ id: z.number().int().positive(), full_path: z.string().min(1).max(255) }),
);
const projects = z.array(
  z.object({
    id: z.number().int().positive(),
    path_with_namespace: z.string().min(1).max(400),
    default_branch: z.string().nullish(),
    created_at: z.string().nullish(),
  }),
);

export type GitlabGroup = { id: string; fullPath: string };
export type GroupProject = {
  id: number;
  fullName: string;
  /** Whether it has a branch yet: a project made empty has none until its first push. */
  empty: boolean;
  createdAt: Date | null;
};

async function page<T>(url: string, token: string, schema: z.ZodType<T>) {
  return platformRead(url, { headers: gitlabHeaders(token) }, async (res) => {
    const bytes = await boundedBytes(res, MAX_BYTES);
    if (!bytes) return null;
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? { body: parsed.data, next: !!res.headers.get("x-next-page") } : null;
  });
}

/** The groups the user has the Maintainer role or above in, oldest first; null when GitLab did not answer. */
export async function gitlabMaintainedGroups(
  origin: string,
  token: string,
): Promise<{ groups: GitlabGroup[]; more: boolean } | null> {
  const out: GitlabGroup[] = [];
  for (let n = 1; n <= GROUP_PAGES; n++) {
    const read = await page(
      `${origin}/api/v4/groups?min_access_level=${MAINTAINER}&order_by=id&sort=asc&per_page=${PER_PAGE}&page=${n}`,
      token,
      groups,
    );
    if (!read) return null;
    out.push(...read.body.map((g) => ({ id: String(g.id), fullPath: g.full_path })));
    if (!read.next) return { groups: out, more: false };
  }
  return { groups: out, more: true };
}

/**
 * The group's newest projects the token sees, its subgroups' included,
 * newest first, archived ones left out; null when GitLab did not answer.
 */
export async function gitlabGroupProjects(
  origin: string,
  token: string,
  groupId: string,
  perPage: number,
): Promise<GroupProject[] | null> {
  const read = await page(
    `${origin}/api/v4/groups/${encodeURIComponent(groupId)}/projects?include_subgroups=true&order_by=id&sort=desc&simple=true&archived=false&per_page=${perPage}`,
    token,
    projects,
  );
  return (
    read?.body.map((p) => {
      const created = p.created_at ? new Date(p.created_at) : null;
      return {
        id: p.id,
        fullName: p.path_with_namespace,
        empty: !p.default_branch,
        createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
      };
    }) ?? null
  );
}
