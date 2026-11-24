import type { Context } from "hono";
import { withCallLimit } from "../calls.js";
import type { ReviewRepo } from "../db/review-jobs.js";
import { type Scoped, scoped } from "../db/scoped.js";
import { defer } from "../defer.js";
import type { BotCredential } from "../platforms/bot.js";
import { COMMIT_ID } from "../platforms/contents.js";
import type { CodePlatform } from "../platforms/platform.js";
import { platformsOf } from "../platforms/registry.js";
import { findingStarting } from "../platforms/threads.js";
import type { CommentCommand } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { fix, stop } from "./fix-commands.js";
import type { AutoReviewService } from "./routes.js";

// A comment with a line that is only `@ocra <command>` is a command, read
// here before the question path (./replies.ts) and run once per comment,
// after the webhook's answer. Only a person the platform says may push to
// the repository is obeyed, as the bot reads it; a refusal is recorded and
// not answered, so no one outside the repository makes the bot write. Each
// command is answered in the pull request's conversation as the bot.

/** Platform calls one command makes: a token, the author's access, the work and the answer. */
const MAX_CALLS = 40;
/** Threads one `@ocra resolve` resolves; a second resolves the rest. */
const MAX_RESOLVED = 20;

const WORDS: Record<string, CommentCommand> = {
  review: "review",
  pause: "pause",
  resume: "resume",
  resolve: "resolve",
  fix: "fix",
  stop: "stop",
  help: "help",
  "generate tests": "generate_tests",
  "generate docstrings": "generate_docstrings",
};

const LINE = /^@ocra\s+([a-z]+(?:\s+[a-z]+)?)[.!]?$/i;
const FENCE = /^(```|~~~)/;

/** The command of the first line outside a code block that is only `@ocra <command>`; null for a question. */
export function parseCommand(body: string): CommentCommand | null {
  let fenced = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) continue;
    const words = LINE.exec(line)?.[1];
    const command = words && WORDS[words.toLowerCase().replace(/\s+/, " ")];
    if (command) return command;
  }
  return null;
}

const HELP = [
  "Commands for ocra, each on a line of its own (people with write access only):",
  "",
  "- `@ocra review`: review the pull request's current head now",
  "- `@ocra pause`: stop reviewing this pull request as it gains commits",
  "- `@ocra resume`: review it as it gains commits again",
  "- `@ocra resolve`: resolve ocra's open review threads",
  "- `@ocra fix`: commit fixes for the open findings, where the repository lets ocra commit",
  "- `@ocra stop`: stop fixing; a fix under way is the last",
  "- `@ocra generate tests` or `@ocra generate docstrings`: commit them to the branch",
  "- `@ocra help`: this list",
  "",
  "Any other `@ocra` comment is a question ocra answers in its thread.",
].join("\n");

type Command = {
  number: number;
  commentId: string;
  command: CommentCommand;
  /** The author as the platform names them for a permission read: GitHub's login, GitLab's user id. */
  author: string | undefined;
};

/** Records the command and runs it after the answer; 1 when it is new, 0 for a redelivery. */
export async function takeCommand(
  c: Context<AppEnv>,
  service: AutoReviewService,
  repo: ReviewRepo,
  command: Command,
): Promise<number> {
  const data = scoped(c.var.db, repo.accountId);
  const id = await data.commands.record(
    repo.id,
    command.number,
    command.commentId,
    command.command,
  );
  if (!id) return 0;
  const platform = platformsOf(c.env, c.req.url).find(
    (p) => p.kind === repo.platform && p.host === repo.host,
  );
  const run = async () => {
    const outcome = await withCallLimit(MAX_CALLS, async () => {
      const bot = platform && (await c.var.bots?.forRepo(repo));
      if (!platform || !bot) return "failed" as const;
      const consoleUrl = c.env.PUBLIC_URL ?? new URL(c.req.url).origin;
      return runCommand({ data, service, platform, bot, repo, consoleUrl }, command);
    }).catch(() => "failed" as const);
    await data.commands.settle(id, outcome, new Date());
  };
  defer(c, run());
  return 1;
}

export type Run = {
  data: Scoped;
  service: AutoReviewService;
  platform: CodePlatform;
  bot: BotCredential;
  repo: ReviewRepo;
  /** The console's address, for an answer that points to a setting. */
  consoleUrl: string;
};

async function runCommand(run: Run, command: Command): Promise<"done" | "refused" | "failed"> {
  const { platform, bot, repo } = run;
  const allowed = command.author
    ? await platform.access.canWrite(bot.token, repo.fullName, command.author)
    : false;
  if (allowed !== true) return allowed === false ? "refused" : "failed";
  const { ok, text } = await perform(run, command);
  const sent = await platform.actions.comment(bot.token, repo.fullName, command.number, text);
  return ok && sent === "done" ? "done" : "failed";
}

export type Answer = { ok: boolean; text: string };

export const short = (head: string) => `\`${head.slice(0, 7)}\``;

async function perform(run: Run, { command, number }: Command): Promise<Answer> {
  const { data, repo } = run;
  switch (command) {
    case "help":
      return { ok: true, text: HELP };
    case "pause":
      return {
        ok: true,
        text: (await data.commands.pause(repo.id, number))
          ? "Paused: ocra no longer reviews this pull request as it gains commits. `@ocra review` still reviews it, `@ocra resume` turns this back on."
          : "This pull request was paused already. `@ocra resume` turns its reviews back on.",
      };
    case "resume":
      return {
        ok: true,
        text: (await data.commands.resume(repo.id, number))
          ? "Resumed: ocra reviews this pull request again as it gains commits."
          : "This pull request was not paused.",
      };
    case "review":
      return review(run, number);
    case "resolve":
      return resolve(run, number);
    case "fix":
      return fix(run, number);
    case "stop":
      return stop(run, number);
    case "generate_tests":
    case "generate_docstrings":
      return generate(run, number, command === "generate_tests" ? "tests" : "docstrings");
  }
}

export const UNREAD: Answer = { ok: false, text: "ocra could not read this pull request's head." };

export async function headOf({ platform, bot, repo }: Run, number: number) {
  const facts = await platform.mergeStatus.facts(bot.token, repo.fullName, number);
  return facts && COMMIT_ID.test(facts.head) ? facts.head : null;
}

async function review(run: Run, number: number): Promise<Answer> {
  const head = await headOf(run, number);
  if (!head) return UNREAD;
  const job = await run.data.autoReview.request(run.repo.id, number, head, false, null, new Date());
  if (!job) return UNREAD;
  if (job.state === "queued") run.service.kick();
  const text =
    job.state === "queued"
      ? `Queued a review of ${short(head)}.`
      : job.state === "running"
        ? `A review of ${short(head)} is under way.`
        : `${short(head)} was reviewed already; a new commit is reviewed when it is pushed or asked for.`;
  return { ok: true, text };
}

async function generate(run: Run, number: number, kind: "tests" | "docstrings"): Promise<Answer> {
  const head = await headOf(run, number);
  if (!head) return UNREAD;
  const queued = await run.data.generations.queue(run.repo.id, number, head, kind);
  if (queued) run.service.kick();
  return {
    ok: true,
    text: queued
      ? `Queued ${kind} for ${short(head)}: ocra commits them to the branch.`
      : `${kind[0]?.toUpperCase()}${kind.slice(1)} for ${short(head)} were asked for already.`,
  };
}

async function resolve({ platform, bot, repo }: Run, number: number): Promise<Answer> {
  const listing = await platform.threads.list(bot.token, repo.fullName, number);
  if (!listing) return { ok: false, text: "ocra could not read this pull request's threads." };
  const open = listing.threads.filter(
    (t) => !t.resolved && t.canResolve && findingStarting(t.comments[0]?.body ?? "") !== undefined,
  );
  let resolved = 0;
  for (const thread of open.slice(0, MAX_RESOLVED)) {
    const done = await platform.threads.resolve(bot.token, repo.fullName, number, thread.id, true);
    if (done?.outcome === "done") resolved++;
  }
  const left = open.length - resolved;
  const text =
    open.length === 0
      ? "ocra has no open threads on this pull request."
      : `Resolved ${resolved} of ocra's open threads.${left > 0 ? ` ${left} still open: \`@ocra resolve\` again for the rest.` : ""}`;
  return { ok: left === 0 || resolved > 0, text };
}
