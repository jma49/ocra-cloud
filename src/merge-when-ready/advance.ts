import { audit } from "../audit.js";
import { type CallBudget, callsRefused, uncapped } from "../calls.js";
import type { Db } from "../db/client.js";
import { dueMergeIntents, type MergeIntent } from "../db/merge-intents.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { evaluatePull, headReview } from "../merge-checks/run.js";
import type { Outbox } from "../notify/notify.js";
import { tellOwnPullEvent } from "../notify/pull-events.js";
import { accessToken } from "../platforms/links.js";
import type { CodePlatform } from "../platforms/platform.js";
import { mergeMethodsOf, mergeOne } from "../pull-page.js";
import type { MergeIntentReason, MergeIntentState } from "../shared/index.js";
import type { AppBindings } from "../types.js";

// A server-kept intent moved on: claimed by compare-and-set so one runner
// merges it, merged as the user through the pull request page's own merge
// (which names the head), or given back saying what it still waits on.
// What ends it is kept on the row, in the audit log, and told to the
// channels that hear about it. The webhooks move it; a sweep reads again
// the ones they left armed (a delivery the platform never sent).

export type MergeRunner = {
  db: Db;
  env: Pick<AppBindings, "MASTER_KEY" | "MASTER_KEY_PREVIOUS">;
  platforms: readonly CodePlatform[];
  out: Outbox;
};

/** An intent of a repository the account enrolled, where its webhooks arrive. */
export type IntentScope = {
  runner: MergeRunner;
  data: Scoped;
  platform: CodePlatform;
  repo: Row<"reviewRepos">;
};

type Ended = Exclude<MergeIntentState, "armed" | "merging">;

const WHAT: Record<Ended, (reason: MergeIntentReason | null) => string> = {
  merged: () => "Your pull request set to merge when ready was merged",
  closed: () => "Your pull request set to merge when ready was closed",
  cancelled: () => "Merge when ready was cancelled",
  disarmed: () => "Merge when ready stopped: the pull request gained commits",
  failed: (reason) =>
    reason === "no_token"
      ? "Merge when ready stopped: connect the platform again"
      : "Merge when ready stopped: the platform refused the merge",
};

/** Records how an intent ended: the audit log, and the channels that hear about it. */
export async function recordEnd(
  scope: Pick<IntentScope, "runner" | "data" | "repo">,
  intent: MergeIntent,
  state: Ended,
  reason: MergeIntentReason | null,
): Promise<void> {
  const { runner, data, repo } = scope;
  await audit(data, `merge_when_ready.${state}`, {
    pull: `${intent.fullName}#${intent.number}`,
    mode: intent.mode,
    method: intent.method,
    head: intent.head,
    reason,
  });
  if (state === "cancelled") return;
  await tellOwnPullEvent(runner.db, data, runner.out, repo, {
    kind: "merge_when_ready",
    key: `merge-when-ready:${intent.id}:${intent.createdAt.getTime()}:${state}`,
    number: intent.number,
    what: WHAT[state](reason),
  });
}

/** What still keeps the head from merging on ocra's side; null when nothing does. */
async function ocraGate(
  scope: IntentScope,
  token: string,
  intent: MergeIntent,
): Promise<MergeIntentReason | null> {
  const { data, platform, repo } = scope;
  const evaluated = await evaluatePull(data, platform, token, repo, intent.number);
  if (evaluated.report) {
    if (evaluated.report.head !== intent.head) return "head_moved";
    if (evaluated.report.conclusion === "pending") return "waiting_checks";
    if (evaluated.report.conclusion === "failure") return "checks_failed";
  } else if (evaluated.reason === "unreachable") {
    return "unreachable";
  }
  const review = await headReview(data, platform, repo, intent.number, intent.head);
  return review && review.unresolvedCritical > 0 ? "blocking_review" : null;
}

/**
 * Tries to merge a server-kept intent now; the row as it then stands. A
 * caller that loses the claim changes nothing.
 */
export async function advance(
  scope: IntentScope,
  intent: MergeIntent,
  now = new Date(),
): Promise<MergeIntent | undefined> {
  const { data, platform } = scope;
  const intents = data.mergeIntents;
  if (intent.mode !== "server") return intent;
  const claim = await intents.claim(intent.id, intent.head, now);
  if (!claim) return intents.of(intent, intent.number);
  // A call the run's budget refused (src/calls.ts) is no answer: the intent
  // goes back as it was, never ended or said to wait on what was not read.
  const cut = () => callsRefused() && intents.giveBack(intent.id, claim, intent);
  const end = async (state: Ended, reason: MergeIntentReason | null) => {
    if (state !== "merged" && (await cut())) return;
    if (await intents.finish(intent.id, claim, state, reason, now)) {
      await recordEnd(scope, intent, state, reason);
    }
  };
  const wait = async (reason: MergeIntentReason, head?: string) =>
    (await cut()) || intents.release(intent.id, claim, reason, now, head);
  const moved = async (head: string) =>
    intent.keepOnPush ? wait("waiting_platform", head) : end("disarmed", "head_moved");
  try {
    const token = await accessToken(data, scope.runner.env, platform);
    if (!token) {
      await end("failed", "no_token");
    } else {
      const pull = await platform.autoMerge.readiness(token, intent.fullName, intent.number);
      if (!pull) await wait("unreachable");
      else if (pull.state !== "open") await end(pull.state, null);
      else if (pull.head !== intent.head) await moved(pull.head);
      else if (!pull.mergeable) await wait("waiting_platform");
      else {
        const blocked = await ocraGate(scope, token, intent);
        if (blocked === "head_moved") await moved(pull.head);
        else if (blocked) await wait(blocked);
        else {
          // The repository's settings may have changed since the intent was armed.
          const allowed = await mergeMethodsOf(platform, token, intent.fullName);
          const merged = await mergeOne(
            platform,
            token,
            {
              repo: intent.fullName,
              number: intent.number,
              method: intent.method,
              head: intent.head,
            },
            allowed,
          );
          if (merged === "done") await end("merged", null);
          else if (merged === "head_moved") await wait("waiting_platform");
          else if (merged === "refused") await end("failed", "refused");
          else await wait(merged === null ? "unreachable" : "waiting_platform");
        }
      }
    }
  } catch (e) {
    await wait("unreachable");
    throw e;
  }
  return intents.of(intent, intent.number);
}

/** Intents a sweep reads; the rest wait for the next. */
const PER_SWEEP = 20;
/** An armed intent the webhooks have not moved for this long is read again. */
const SWEEP_IDLE_MS = 15 * 60_000;
/** What reading one takes at most past the link's token: the pull request, its checks' facts, the methods, the merge. */
const FEWEST_CALLS = 4;

/**
 * Reads again the armed intents untouched longest, across accounts, while
 * `calls` has room for one more; how many it tried. One its calls cut short
 * is given back as it was, and ends the sweep.
 */
export async function sweepMergeIntents(
  runner: MergeRunner,
  now = new Date(),
  calls: CallBudget = uncapped(),
): Promise<number> {
  const due = await dueMergeIntents(runner.db, now, SWEEP_IDLE_MS, PER_SWEEP);
  let tried = 0;
  for (const intent of due) {
    if (calls.refused > 0 || !calls.has(FEWEST_CALLS)) break;
    tried++;
    const platform = runner.platforms.find(
      (p) => p.kind === intent.platform && p.host === intent.host,
    );
    if (!platform) continue;
    const data = scoped(runner.db, intent.accountId);
    const repo = await data.mergeChecks.enrolledRepo(platform.kind, platform.host, intent.fullName);
    if (!repo) continue;
    try {
      await advance({ runner, data, platform, repo }, intent, now);
    } catch (e) {
      logError("merge_when_ready_failed", { repo: repo.id, error: errorName(e) });
    }
  }
  return tried;
}
