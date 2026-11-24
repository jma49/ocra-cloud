import { recordGithubFindingThread } from "../src/auto-review/finding-threads.js";
import { scoped } from "../src/db/scoped.js";
import { db, signIn } from "./helpers.js";

// An enrolled GitHub repository, a pull request with ocra's finding on it,
// and a person resolving or reopening its comment's thread, for the tests
// of what moves a finding out of the open state.

export const HUB = "https://github.com";
export const FP = "0123456789abcdef";
export const PR = "https://github.com/octo/api";
export const bot = { id: 900, login: "ocra[bot]", type: "Bot" };
const rita = { id: 7, login: "rita", type: "User" };
const start = {
  id: 100,
  body: `<!-- ocra:finding ${FP} -->\n**Bug.** Retry-After as a date.`,
  user: bot,
  created_at: "2026-11-02T10:00:00Z",
};

export async function enrolled() {
  const me = await signIn(42, "mona");
  const data = scoped(db, me.account.id);
  await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "Octo/API",
  });
  return { me, data };
}

export const thread = (action: "resolved" | "unresolved", at: string, by = rita) =>
  recordGithubFindingThread(db, "github.com", HUB, "pull_request_review_thread", {
    action,
    pull_request: { number: 7, updated_at: at },
    thread: { node_id: "T1", comments: [start] },
    sender: by,
    repository: { id: 11 },
  });
