import { audit } from "../audit.js";
import { type CallBudget, item, uncapped, withCallLimit } from "../calls.js";
import type { Db } from "../db/client.js";
import { type Scoped, scoped } from "../db/scoped.js";
import { dueStackMerges, type StackMerge, type StackProgress } from "../db/stack-merges.js";
import { masterKeys } from "../keyring.js";
import { errorName, logError } from "../log.js";
import type { Outbox } from "../notify/notify.js";
import { tellOwnPullEvent } from "../notify/pull-events.js";
import { accessToken } from "../platforms/links.js";
import type { CodePlatform } from "../platforms/platform.js";
import { MAX_STACK } from "../platforms/stacks.js";
import { mergeMethodsOf, mergeOne } from "../pull-page.js";
import type { StackMergeLayer, StackMergeReason, StackMergeStep } from "../shared/index.js";
import type { AppBindings } from "../types.js";

// A stack merge moved on, one claimed step at a time: the layer it is on is
// read from the platform, retargeted to the trunk, brought up to date where
// the repository wants that, and merged as the user once the platform would
// merge it; then the layers stacked on it are moved onto the trunk and the
// next one is taken. It waits between steps on the layer's checks and the
// platform's rules, moved on by webhooks, the sweep and the status page, and
// stops with a reason on what waiting will not fix. A run inside a request
// makes only so many platform calls (a Worker's request may make 50): a
// tall stack that could go on is left waiting, in progress, for the next
// run. How it ended is told to the channels that hear about stack merges.

export type StackRunner = {
  db: Db;
  env: Pick<AppBindings, "MASTER_KEY" | "MASTER_KEY_PREVIOUS"> &
    Partial<Pick<AppBindings, "PUBLIC_URL" | "SESSION_SECRET">>;
  platforms: readonly CodePlatform[];
  /** Where the end is told from; without it, the env's PUBLIC_URL with no mailer, or nowhere. */
  out?: Outbox | undefined;
};

export type StackScope = { runner: StackRunner; data: Scoped; platform: CodePlatform };

/** A merge not done by then is stopped: what it waits on is not coming. */
const STACK_MERGE_TIMEOUT_MS = 3 * 24 * 60 * 60_000;

/** One step is either a platform read, a write, or both: this many is every layer twice over. */
const MAX_STEPS = MAX_STACK * 4;

/**
 * The platform calls a run inside a request makes at most, beside the
 * request's own: together well under the 50 a Worker's request may make.
 */
export const REQUEST_CALLS = 20;

/** What one more step may take: the layer's read, the repository's merge methods and the merge. */
const STEP_CALLS = 3;

const pullOf = (merge: StackMerge) => `${merge.path}#${merge.bottom}`;
const topOf = (merge: StackMerge) => merge.chain[merge.chain.length - 1]?.number ?? merge.bottom;

type Ended = "merged" | "failed";

/**
 * Takes one claimed run of a merge as far as it goes now, within `limit`
 * platform calls (and the budget the caller runs in); the row as it then
 * stands. A caller that loses the claim changes nothing.
 */
export async function advanceStack(
  scope: StackScope,
  merge: StackMerge,
  now = new Date(),
  limit = Number.POSITIVE_INFINITY,
): Promise<StackMerge | undefined> {
  const merges = scope.data.stackMerges;
  const claim = await merges.claim(merge.id, now);
  if (!claim) return merges.byId(merge.id);
  const ended = await withCallLimit(limit, async (calls) => {
    const run = new Run(scope, merge, claim, now, calls);
    try {
      await run.steps();
    } catch (e) {
      await run.wait("unreachable");
      // A call its budget refused was never sent: the merge waits for the next run.
      if (calls.refused === 0) throw e;
    }
    return run.ended;
  });
  // Told outside the run's calls, which the merge may have used up.
  if (ended) await tellEnd(scope, ended.at, ended.state, ended.reason);
  return merges.byId(merge.id);
}

const STOPPED: Record<StackMergeReason, string> = {
  waiting_checks: "its checks did not finish",
  waiting_platform: "the platform did not let it merge",
  updating: "its branch was not brought up to date",
  checks_failed: "its checks failed",
  conflicts: "it has conflicts",
  refused: "the platform refused",
  head_moved: "it gained commits",
  closed: "it was closed",
  stack_changed: "the stack changed",
  no_token: "connect the platform again",
  unreachable: "the platform did not answer",
  timed_out: "it waited too long",
};

const outboxOf = ({ out, env }: StackRunner): Outbox | undefined =>
  out ??
  (env.PUBLIC_URL && env.SESSION_SECRET
    ? {
        keys: masterKeys(env),
        mailer: undefined,
        linkSecret: env.SESSION_SECRET,
        origin: new URL(env.PUBLIC_URL).origin,
      }
    : undefined);

/**
 * Tells the account's channels that hear about stack merges how this one
 * ended, each once; the merge ended whether or not its notice goes.
 */
async function tellEnd(
  scope: StackScope,
  merge: StackMerge,
  state: Ended,
  reason: StackMergeReason | null,
): Promise<void> {
  try {
    const out = outboxOf(scope.runner);
    if (out) await tell(scope, out, merge, state, reason);
  } catch (e) {
    logError("stack_merge_notice_failed", { error: errorName(e) });
  }
}

async function tell(
  scope: StackScope,
  out: Outbox,
  merge: StackMerge,
  state: Ended,
  reason: StackMergeReason | null,
): Promise<void> {
  const layers = merge.chain.length;
  const what =
    state === "merged"
      ? `Your stack merge finished: ${layers} pull request${layers === 1 ? "" : "s"} merged`
      : `Your stack merge stopped at #${merge.current}: ${STOPPED[reason ?? "refused"]}`;
  const repo = { platform: merge.platform, host: merge.host, fullName: merge.path };
  await tellOwnPullEvent(scope.runner.db, scope.data, out, repo, {
    kind: "stack_merge",
    key: `stack-merge:${merge.id}:${state}`,
    number: state === "merged" ? topOf(merge) : merge.current,
    what,
  });
}

/** One claimed run: every write names the claim, so a cancel or a takeover stops it. */
class Run {
  private at: StackMerge;
  /** How the run ended the merge, if it did. */
  ended: { at: StackMerge; state: Ended; reason: StackMergeReason | null } | undefined;
  constructor(
    private readonly scope: StackScope,
    private readonly merge: StackMerge,
    private readonly claim: Date,
    private readonly now: Date,
    private readonly calls: CallBudget,
  ) {
    this.at = merge;
  }

  private get merges() {
    return this.scope.data.stackMerges;
  }

  wait(reason: StackMergeReason): Promise<boolean> {
    return this.merges.release(this.merge.id, this.claim, reason, this.now);
  }

  private async end(state: Ended, reason: StackMergeReason | null): Promise<void> {
    const { merge } = this;
    if (!(await this.merges.finish(merge.id, this.claim, state, reason, this.now))) return;
    const detail = { pull: pullOf(merge), top: topOf(merge), method: merge.method };
    if (state === "merged") await audit(this.scope.data, "stack_merge.merged", detail);
    else await audit(this.scope.data, "stack_merge.failed", { ...detail, reason });
    this.ended = { at: this.at, state, reason };
  }

  private save(progress: StackProgress): Promise<boolean> {
    this.at = { ...this.at, ...progress };
    return this.merges.save(this.merge.id, this.claim, progress, this.now);
  }

  async steps(): Promise<void> {
    const { platform, runner, data } = this.scope;
    const token = await accessToken(data, runner.env, platform);
    if (!token) return this.end("failed", "no_token");
    if (this.now.getTime() - this.merge.createdAt.getTime() > STACK_MERGE_TIMEOUT_MS) {
      return this.end("failed", "timed_out");
    }
    for (let n = 0; n < MAX_STEPS; n++) {
      // Out of calls with more to do: left in progress for the next run.
      if (!this.calls.has(STEP_CALLS)) break;
      const moved = await this.step(token);
      if (moved !== "next") return;
    }
    await this.wait("waiting_platform");
  }

  /** One read of the layer it is on, and what that calls for; `next` to read again at once. */
  private async step(token: string): Promise<"next" | "stop"> {
    const { platform } = this.scope;
    const at = this.at;
    const repo = at.path;
    const stop = async (done: Promise<unknown>) => {
      await done;
      return "stop" as const;
    };
    const next = async (progress: StackProgress) =>
      (await this.save(progress)) ? ("next" as const) : ("stop" as const);
    const layer = at.chain[at.step];
    if (!layer) return stop(this.end("merged", null));
    const standing = await platform.stacks.standing(token, repo, layer.number);
    if (!standing) return stop(this.wait("unreachable"));
    if (standing.state === "closed") return stop(this.end("failed", "closed"));
    if (standing.state === "merged") {
      // Merged into a branch of the stack, not the trunk: what the next layer holds did not land.
      if (standing.base !== at.trunk) return stop(this.end("failed", "stack_changed"));
      // Merged by this run, or on the platform directly: the ones above it move on.
      const { restacked, cut } = await restack(this.scope, token, at, standing.headBranch);
      // The run's calls ran out mid-way: what moved is kept, the next run moves the rest.
      if (cut) return stop(this.save({ restacked }).then(() => this.wait("unreachable")));
      const above = at.chain[at.step + 1];
      const current = above ? { current: above.number, head: above.head } : {};
      return next({ step: at.step + 1, ...current, updatedFrom: null, restacked });
    }
    if (standing.base !== at.trunk) {
      if (at.step === 0) return stop(this.end("failed", "stack_changed"));
      const moved = await platform.stacks.retarget(token, repo, layer.number, at.trunk);
      if (moved === null) return stop(this.wait("unreachable"));
      if (moved !== "done") return stop(this.end("failed", "refused"));
      return next({});
    }
    if (standing.head !== layer.head) {
      // Only the platform's own update of the branch, which this run asked for, moves a layer.
      if (at.updatedFrom !== layer.head) return stop(this.end("failed", "head_moved"));
      const chain = at.chain.map((l, i) => (i === at.step ? { ...l, head: standing.head } : l));
      return next({ chain, head: standing.head, updatedFrom: null });
    }
    switch (standing.blocker) {
      case "conflicts":
        return stop(this.end("failed", "conflicts"));
      case "checks_failed":
        return stop(this.end("failed", "checks_failed"));
      case "checks_pending":
        return stop(this.wait("waiting_checks"));
      case "waiting":
        return stop(this.wait("waiting_platform"));
      case "behind":
        return this.update(token, layer);
      case null:
        return this.mergeLayer(token, layer);
    }
  }

  /** Asks the platform to bring a layer whose base moved on up to date, once per head. */
  private async update(token: string, layer: StackMergeLayer): Promise<"stop"> {
    if (this.at.updatedFrom === layer.head) {
      await this.wait("updating");
      return "stop";
    }
    const { platform } = this.scope;
    const sent = await platform.edits.updateBranch(token, this.at.path, layer.number, layer.head);
    if (sent === null) await this.wait("unreachable");
    else if (sent === "updating") {
      if (await this.save({ updatedFrom: layer.head })) await this.wait("updating");
    } else if (sent === "conflicts") await this.end("failed", "conflicts");
    else if (sent === "forbidden") await this.end("failed", "refused");
    else if (sent === "not_open") await this.end("failed", "closed");
    else await this.wait("waiting_platform");
    return "stop";
  }

  private async mergeLayer(token: string, layer: StackMergeLayer): Promise<"next" | "stop"> {
    // The claim is checked once more just before the merge: a cancel since stops it here.
    if (!(await this.save({}))) return "stop";
    const { platform } = this.scope;
    const repo = this.at.path;
    const allowed = await mergeMethodsOf(platform, token, repo);
    const merged = await mergeOne(
      platform,
      token,
      { repo, number: layer.number, method: this.at.method, head: layer.head },
      allowed,
    );
    // Merged: the next read sees it so and moves on.
    if (merged === "done") return "next";
    if (merged === null) await this.wait("unreachable");
    else if (merged === "refused") await this.end("failed", "refused");
    else await this.wait("waiting_platform");
    return "stop";
  }
}

/**
 * Moves the open pull requests stacked on a merged branch, but not in the
 * chain (it moves those itself), onto the trunk; what it did, kept with the
 * merge's earlier ones, and whether the run's calls ran out before the end.
 */
async function restack(
  scope: StackScope,
  token: string,
  merge: StackMerge,
  branch: string,
): Promise<{ restacked: StackMergeStep[]; cut: boolean }> {
  const kept = [...merge.restacked];
  const done = (cut: boolean) => ({ restacked: kept.slice(-MAX_STACK), cut });
  const above = await item(() => scope.platform.stacks.children(token, merge.path, branch));
  if (above.cut) return done(true);
  const inChain = new Set(merge.chain.map((l) => l.number));
  for (const pull of (above.value ?? []).slice(0, MAX_STACK)) {
    if (inChain.has(pull.number) || kept.some((s) => s.number === pull.number)) continue;
    const moved = await item(() =>
      scope.platform.stacks.retarget(token, merge.path, pull.number, merge.trunk),
    );
    if (moved.cut) return done(true);
    kept.push({ number: pull.number, outcome: moved.value ?? "unreached" });
  }
  return done(false);
}

/** Merges a sweep moves; the rest wait for the next. */
const PER_SWEEP = 20;
/** A waiting merge the webhooks have not moved for this long is read again. */
const SWEEP_IDLE_MS = 60_000;

/** What a merge is started with at least: the link's token, a read of its layer and one move. */
const FEWEST_CALLS = 3;

/**
 * Moves on the merges that waited longest, across accounts, while `calls`
 * has room for one more; how many it tried. One its calls cut short waits,
 * as when the platform did not answer, for the next sweep.
 */
export async function sweepStackMerges(
  runner: StackRunner,
  now = new Date(),
  calls: CallBudget = uncapped(),
): Promise<number> {
  const due = await dueStackMerges(runner.db, now, SWEEP_IDLE_MS, PER_SWEEP);
  let tried = 0;
  for (const row of due) {
    if (!calls.has(FEWEST_CALLS)) break;
    tried++;
    const platform = runner.platforms.find((p) => p.kind === row.platform && p.host === row.host);
    if (!platform) continue;
    const data = scoped(runner.db, row.accountId);
    const merge = await data.stackMerges.byId(row.id);
    if (!merge) continue;
    try {
      await advanceStack({ runner, data, platform }, merge, now);
    } catch (e) {
      logError("stack_merge_failed", { error: errorName(e) });
    }
  }
  return tried;
}
