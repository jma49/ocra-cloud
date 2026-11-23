import { z } from "zod";
import { audit } from "../audit.js";
import { accountSalt } from "../db/accounts.js";
import type { Db } from "../db/client.js";
import { accountsOfRepo, githubReposOf, type PlatformRepoRef } from "../db/repo-lifecycle.js";
import { scoped } from "../db/scoped.js";
import { type CodePlatform, repoHashOf } from "../platforms/platform.js";
import type { RepoPause } from "../shared/index.js";

// What becomes of enrolled repositories as they change on their platform.
// A rename or transfer keeps the enrollment, its settings and its history
// under the new name (src/db/repo-lifecycle.ts): GitHub's `repository`
// webhook says so, a GitLab hook's project path does, and the daily
// reconciliation reads the name by the platform's id for what a webhook
// missed (src/reconcile.ts). A repository deleted, removed from the App's
// installation, or whose installation is suspended or uninstalled is
// paused: its queued jobs are given up, no job of it runs, its history
// stays; added back, unsuspended or installed again, it resumes. Nothing
// here calls the platform.

type Site = Pick<CodePlatform, "kind" | "host" | "url">;

/** Repositories one lifecycle delivery acts on at most, across accounts. */
const MAX_LIFECYCLE_REPOS = 1000;

const ACCOUNT_REPO_NAME = /^[\w.-]+(?:\/[\w.-]+)+$/;

async function hashesOf(db: Db, site: Site, accountId: string, from: string, to: string) {
  try {
    const salt = await accountSalt(db, accountId);
    return {
      from: await repoHashOf(salt, site, from),
      to: await repoHashOf(salt, site, to),
    };
  } catch {
    return null;
  }
}

/**
 * Renames the repository the platform's id names to `to` for every account
 * that enrolled it or keeps its graph; how many enrollments it renamed.
 */
export async function renameRepository(
  db: Db,
  site: Site,
  platformRepoId: string,
  to: string,
): Promise<number> {
  if (!ACCOUNT_REPO_NAME.test(to) || to.length > 400) return 0;
  const ref: PlatformRepoRef = { platform: site.kind, host: site.host, platformRepoId };
  let renamed = 0;
  for (const { accountId, fullName: from } of await accountsOfRepo(db, ref)) {
    if (from === to) continue;
    const data = scoped(db, accountId);
    const hashes = await hashesOf(db, site, accountId, from, to);
    if (await data.repoLifecycle.rename({ ...ref, from, to, hashes })) {
      renamed++;
      await audit(data, "auto_review.renamed", { repo: to, previous: from });
    }
  }
  return renamed;
}

type Found = Awaited<ReturnType<typeof githubReposOf>>;

async function pauseAll(db: Db, repos: Found, reason: RepoPause, now: Date): Promise<number> {
  let n = 0;
  for (const [accountId, own] of byAccount(repos)) {
    const data = scoped(db, accountId);
    const paused = new Set(await data.repoLifecycle.pause([...own.keys()], reason, now));
    for (const id of paused)
      await audit(data, "auto_review.paused", { repo: own.get(id) ?? "", reason });
    n += paused.size;
  }
  return n;
}

async function resumeAll(db: Db, repos: Found, reason: RepoPause): Promise<number> {
  let n = 0;
  for (const [accountId, own] of byAccount(repos)) {
    const data = scoped(db, accountId);
    const resumed = await data.repoLifecycle.resume([...own.keys()], reason);
    for (const id of resumed)
      await audit(data, "auto_review.resumed", { repo: own.get(id) ?? "", reason });
    n += resumed.length;
  }
  return n;
}

function byAccount(repos: Found): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const r of repos) {
    const own = out.get(r.accountId) ?? new Map<string, string>();
    own.set(r.id, r.fullName);
    out.set(r.accountId, own);
  }
  return out;
}

const listed = z.array(z.object({ id: z.number() })).max(MAX_LIFECYCLE_REPOS);

const repositoryEvent = z.object({
  action: z.string(),
  repository: z.object({ id: z.number(), full_name: z.string().max(400) }),
});

const installationReposEvent = z.object({
  action: z.enum(["added", "removed"]),
  repositories_added: listed.optional(),
  repositories_removed: listed.optional(),
});

const installationEvent = z.object({
  action: z.string(),
  installation: z.object({
    account: z.object({ login: z.string().max(100) }).nullish(),
    repository_selection: z.string().optional(),
  }),
  repositories: listed.optional(),
});

const idsOf = (list: { id: number }[] | undefined) => (list ?? []).map((r) => String(r.id));

/**
 * Acts on a GitHub App delivery about a repository's or an installation's
 * life; how many enrolled repositories it changed (0 for any other event).
 */
export async function githubLifecycle(
  db: Db,
  site: Site,
  event: string,
  body: unknown,
  now: Date,
): Promise<number> {
  const find = (ids: string[], owner: string | null) =>
    githubReposOf(db, site.host, { ids, owner }, MAX_LIFECYCLE_REPOS);
  if (event === "repository") {
    const parsed = repositoryEvent.safeParse(body);
    if (!parsed.success) return 0;
    const { action, repository } = parsed.data;
    const id = String(repository.id);
    if (action === "renamed" || action === "transferred") {
      return renameRepository(db, site, id, repository.full_name);
    }
    if (action === "deleted") return pauseAll(db, await find([id], null), "deleted", now);
    return 0;
  }
  if (event === "installation_repositories") {
    const parsed = installationReposEvent.safeParse(body);
    if (!parsed.success) return 0;
    const { action, repositories_added, repositories_removed } = parsed.data;
    return action === "removed"
      ? pauseAll(db, await find(idsOf(repositories_removed), null), "removed", now)
      : resumeAll(db, await find(idsOf(repositories_added), null), "removed");
  }
  if (event === "installation") {
    const parsed = installationEvent.safeParse(body);
    if (!parsed.success) return 0;
    const { action, installation, repositories } = parsed.data;
    const ids = idsOf(repositories);
    // An App is installed once on a user or organisation: its repositories are the owner's.
    const owner = installation.account?.login ?? null;
    switch (action) {
      case "deleted":
        return pauseAll(db, await find(ids, owner), "uninstalled", now);
      case "suspend":
        return pauseAll(db, await find(ids, owner), "suspended", now);
      case "unsuspend":
        return resumeAll(db, await find(ids, owner), "suspended");
      case "created":
        // Installed again: on the repositories it was given, or all of the owner's.
        return resumeAll(
          db,
          await find(ids, installation.repository_selection === "all" ? owner : null),
          "uninstalled",
        );
      default:
        return 0;
    }
  }
  return 0;
}
