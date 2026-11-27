import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.js";
import { apiError, jsonBody } from "./http.js";
import { LOGIN } from "./platforms/reviewers.js";
import { type PeopleEdit, sameLogin } from "./platforms/roster.js";
import { byKind, reach } from "./pull-page.js";
import { pullRef, repoRef } from "./pull-ref.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import {
  MAX_PEOPLE_CANDIDATES,
  MAX_PEOPLE_EDITS,
  MAX_PEOPLE_PREFIX,
  type PullActionOutcome,
  type PullCandidatesView,
  type PullPeopleRequest,
  type PullPeopleView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A pull request's reviewers, their answers and its assignees on its page,
// and the repository's people to ask, read live as the signed-in user and
// changed as them. Nothing read or sent is kept but the audit entry.

export const pullPeople = new Hono<AppEnv>();

/** A login as people write one, `@` and spaces included, checked once they are dropped. */
const normalised = (s: string) => s.normalize("NFC").trim().replace(/^@/, "");
export const login = z
  .string()
  .max(MAX_PEOPLE_PREFIX + 2)
  .transform(normalised)
  .pipe(z.string().regex(LOGIN));
const prefix = z
  .string()
  .max(MAX_PEOPLE_PREFIX + 2)
  .transform(normalised)
  .pipe(z.string().regex(/^[A-Za-z0-9_.-]*$/));

const distinct = (logins: string[]) =>
  logins.every((l, i) => logins.findIndex((m) => sameLogin(m, l)) === i);
const peopleBody = z
  .object({
    ...pullRef,
    add: z.array(login).max(MAX_PEOPLE_EDITS).default([]),
    remove: z.array(login).max(MAX_PEOPLE_EDITS).default([]),
  })
  .refine((e) => e.add.length + e.remove.length > 0, "no one to change")
  .refine((e) => distinct([...e.add, ...e.remove]), "a login twice");

const refQuery = z.object(pullRef);
const candidatesQuery = z.object({
  ...repoRef,
  prefix: prefix.default(""),
});

pullPeople.get("/people", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = refQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const { repo, number } = ref.data;
  const read = await platform.roster.read(token, repo, number);
  if (!read) return apiError(c, "not_found");
  return c.json({
    platform: platform.kind,
    repo,
    number,
    author: read.author,
    reviewers: read.reviewers.map((r) => ({ login: r.login, state: r.state })),
    teams: read.teams.map((t) => ({ slug: t.slug, name: t.name })),
    assignees: [...read.assignees],
    truncated: read.truncated,
  } satisfies PullPeopleView);
});

pullPeople.get("/people/candidates", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = candidatesQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, (p) => p.kind === ref.data.platform);
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const listing = await platform.roster.candidates(
    token,
    ref.data.repo,
    ref.data.prefix,
    MAX_PEOPLE_CANDIDATES,
  );
  if (!listing) return apiError(c, "not_found");
  return c.json({
    candidates: listing.candidates.map((p) => ({ login: p.login, name: p.name })),
    truncated: listing.truncated,
  } satisfies PullCandidatesView);
});

type Field = "reviewers" | "assignees";

/** Audits a change the platform made; `pull` as the other pull request entries write it. */
export async function auditPeople(
  c: Context<AppEnv>,
  field: Field,
  at: { repo: string; number: number },
  edit: PeopleEdit,
) {
  await audit(c.var.data, `pull.${field}_changed`, {
    pull: `${at.repo}#${at.number}`,
    added: [...edit.add],
    removed: [...edit.remove],
  });
}

for (const field of ["reviewers", "assignees"] as const) {
  pullPeople.post(
    `/people/${field}`,
    requireSession(["web"]),
    perMinute("platform"),
    jsonBody(peopleBody),
    async (c) => {
      const edit: PullPeopleRequest = c.req.valid("json");
      const reached = await reach(c, byKind(edit));
      if ("refusal" in reached) return reached.refusal;
      const { platform, token } = reached;
      const change =
        field === "reviewers" ? platform.roster.editReviewers : platform.roster.editAssignees;
      const outcome = await change(token, edit.repo, edit.number, edit);
      if (!outcome) return apiError(c, "upstream_unreachable");
      if (outcome === "done") await auditPeople(c, field, edit, edit);
      return c.json({ outcome } satisfies { outcome: PullActionOutcome });
    },
  );
}
