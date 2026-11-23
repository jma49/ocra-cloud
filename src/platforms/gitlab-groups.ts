import { z } from "zod";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { boundedBytes, platformCall, platformRead } from "./http.js";

// The groups a GitLab merge request's approval rules name (Premium and
// Ultimate; GitLab has no group reviewers, a merge request's reviewers are
// users) and who is directly on a group, as GitLab lets approval rules count
// them, and who has approved the merge request now. Each call is bounded in
// time, size and pages, and never retried.

export type ApprovalGroup = { id: number; path: string };

/** The rules' answer read at most: each rule lists its users too. */
const MAX_RULES_BYTES = 1024 * 1024;
/** Groups taken from one merge request's rules at most. */
const MAX_GROUPS = 20;
const PER_PAGE = 100;
/** Pages of a group's members read at most: the first 1,000, as many as src/db/review-teams.ts keeps. */
const MEMBER_PAGES = 10;
/** Rules a group in them asks approval of; report rules are security policy, any_approver names none. */
const ASKING_RULES = new Set(["regular", "code_owner"]);

const rules = z.array(
  z.object({
    rule_type: z.string(),
    groups: z
      .array(z.object({ id: z.number().int().positive(), full_path: z.string().min(1).max(255) }))
      .nullish(),
  }),
);

/** The JSON GitLab answers url with, read up to MAX_RULES_BYTES; undefined when it did not. */
async function boundedJson(url: string, token: string): Promise<unknown> {
  const bytes = await platformRead(url, { headers: gitlabHeaders(token) }, (res) =>
    boundedBytes(res, MAX_RULES_BYTES),
  );
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** The groups the merge request's asking approval rules name; null when GitLab did not answer. */
export async function gitlabApprovalGroups(
  origin: string,
  token: string,
  fullName: string,
  number: number,
): Promise<ApprovalGroup[] | null> {
  const url = `${mergeRequestUrl(origin, fullName, number)}/approval_rules?per_page=${PER_PAGE}`;
  const parsed = rules.safeParse(await boundedJson(url, token));
  if (!parsed.success) return null;
  const groups = new Map<number, ApprovalGroup>();
  for (const rule of parsed.data) {
    if (!ASKING_RULES.has(rule.rule_type)) continue;
    for (const g of rule.groups ?? []) groups.set(g.id, { id: g.id, path: g.full_path });
  }
  return [...groups.values()].slice(0, MAX_GROUPS);
}

const approvals = z.object({
  approved_by: z.array(z.object({ user: z.object({ id: z.number() }).nullish() })).nullish(),
});

/** The ids of the users whose approval of the merge request stands; null when GitLab did not answer. */
export async function gitlabApprovers(
  origin: string,
  token: string,
  fullName: string,
  number: number,
): Promise<string[] | null> {
  const url = `${mergeRequestUrl(origin, fullName, number)}/approvals`;
  const parsed = approvals.safeParse(await boundedJson(url, token));
  if (!parsed.success) return null;
  return (parsed.data.approved_by ?? []).flatMap((a) => (a.user ? [String(a.user.id)] : []));
}

const members = z.array(z.object({ id: z.number(), state: z.string().optional() }));

/** The ids of the group's direct, active members; null when a page is refused. */
export async function gitlabGroupMembers(
  origin: string,
  token: string,
  groupId: number,
): Promise<string[] | null> {
  const ids: string[] = [];
  for (let page = 1; page <= MEMBER_PAGES; page++) {
    const listed = members.safeParse(
      await platformCall<unknown>(
        `${origin}/api/v4/groups/${groupId}/members?per_page=${PER_PAGE}&page=${page}`,
        { headers: gitlabHeaders(token) },
      ),
    );
    if (!listed.success) return null;
    for (const m of listed.data) {
      if (Number.isSafeInteger(m.id) && (m.state ?? "active") === "active") ids.push(String(m.id));
    }
    if (listed.data.length < PER_PAGE) break;
  }
  return ids;
}
