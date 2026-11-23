import { z } from "zod";
import { githubInstallationAdds } from "../auto-review/auto-enroll.js";
import { autoEnrollFor } from "../db/auto-enroll.js";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import type { Row } from "../db/scoped.js";
import { githubSignal, hasIntents, type PullSignal } from "../merge-when-ready/hooks.js";
import {
  githubMerged,
  githubRetargeted,
  hasStackWork,
  type MergedPull,
} from "../stack-merge/hooks.js";
import type { InboundStep } from "./run.js";

// Which of a delivery's durable steps have work, decided before it is
// recorded: one with none keeps no record (./receive.ts). Most of a busy
// repository's deliveries (checks starting, pending statuses, pushes) are
// told apart by their fields alone; the rest cost a read or two, never a
// write: the repository's enrollment (or an installation's switch, for
// the repositories added to it), and whether an intent is armed or a
// stack merge waits (a merged pull request always has work: its stack).

/** The events whose side effects tell the account's channels (src/notify/pull-hooks.ts). */
const TELLS = new Set([
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "pull_request_review_comment",
]);

const githubRepository = z.object({ repository: z.object({ id: z.number() }) });

function repositoryId(body: unknown): string | undefined {
  const parsed = githubRepository.safeParse(body);
  return parsed.success ? String(parsed.data.repository.id) : undefined;
}

/** A GitHub App delivery's steps: none unless its repository is enrolled; ci, a failure it tells of. */
export async function githubSteps(
  db: Db,
  host: string,
  event: string,
  body: unknown,
  ci = false,
): Promise<InboundStep[]> {
  const adds = githubInstallationAdds(event, body);
  if (adds) return (await autoEnrollFor(db, host, adds.installationId)) ? ["enroll"] : [];
  const tells = TELLS.has(event) || ci;
  const said = githubSignal(event, body);
  if (!tells && !said) return [];
  const id = said?.repoId ?? repositoryId(body);
  const repo = id === undefined ? undefined : await reviewRepoFor(db, "github", host, id);
  if (!repo) return [];
  const moves =
    !!said &&
    ((await hasIntents(db, repo, said.fullName, said.signal)) ||
      (await hasStackWork(
        db,
        repo,
        said.fullName,
        said.signal,
        githubMerged(event, body),
        githubRetargeted(event, body),
      )));
  return [...(tells ? (["tell"] as const) : []), ...(moves ? (["intents"] as const) : [])];
}

/** A GitLab hook's steps, for the project its secret proved. */
export async function gitlabSteps(
  db: Db,
  repo: Row<"reviewRepos">,
  tells: boolean,
  signal: PullSignal | undefined,
  merged: MergedPull | null,
): Promise<InboundStep[]> {
  const moves =
    !!signal &&
    ((await hasIntents(db, repo, repo.fullName, signal)) ||
      (await hasStackWork(db, repo, repo.fullName, signal, merged)));
  return [...(tells ? (["tell"] as const) : []), ...(moves ? (["intents"] as const) : [])];
}
