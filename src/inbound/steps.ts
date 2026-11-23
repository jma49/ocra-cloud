import { z } from "zod";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import type { Row } from "../db/scoped.js";
import { githubSignal, hasIntents, type PullSignal } from "../merge-when-ready/hooks.js";
import type { InboundStep } from "./run.js";

// Which of a delivery's durable steps have work, decided before it is
// recorded: one with none keeps no record (./receive.ts). Most of a busy
// repository's deliveries (checks starting, pending statuses, pushes) are
// told apart by their fields alone; the rest cost a read or two, never a
// write: the repository's enrollment, and whether an intent is armed.

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

/** A GitHub App delivery's steps: none unless its repository is enrolled. */
export async function githubSteps(
  db: Db,
  host: string,
  event: string,
  body: unknown,
): Promise<InboundStep[]> {
  const tells = TELLS.has(event);
  const said = githubSignal(event, body);
  if (!tells && !said) return [];
  const id = said?.repoId ?? repositoryId(body);
  const repo = id === undefined ? undefined : await reviewRepoFor(db, "github", host, id);
  if (!repo) return [];
  const moves = !!said && (await hasIntents(db, repo, said.fullName, said.signal));
  return [...(tells ? (["tell"] as const) : []), ...(moves ? (["intents"] as const) : [])];
}

/** A GitLab hook's steps, for the project its secret proved. */
export async function gitlabSteps(
  db: Db,
  repo: Row<"reviewRepos">,
  tells: boolean,
  signal: PullSignal | undefined,
): Promise<InboundStep[]> {
  const moves = !!signal && (await hasIntents(db, repo, repo.fullName, signal));
  return [...(tells ? (["tell"] as const) : []), ...(moves ? (["intents"] as const) : [])];
}
