import type { Db } from "./db/client.js";
import { claimReconcile, type ReconcileTurn, releaseReconcile } from "./db/reconcile.js";
import { type Scoped, scoped } from "./db/scoped.js";
import { errorName, logError } from "./log.js";
import type { BotTokens } from "./platforms/bot.js";
import { accessToken } from "./platforms/links.js";
import type { CodePlatform } from "./platforms/platform.js";
import { CallBudget, type ReconciledPull } from "./platforms/reconcile.js";
import type { AppBindings } from "./types.js";

// The daily reconciliation of enrolled repositories: what their webhooks
// missed, read from the platform as the bot or else the enrolling account's
// link. A pull request that closed with no close on record gets one; one
// the console holds open but the platform closed gets its close; an open
// one with no flow, or a draft state the platform changed since, is merged
// into its flow. Every write is one the webhooks make too, merged in the
// statement (closes and flows keep what a webhook recorded), so the two
// never undo each other. Run hourly, it reads each repository once a UTC
// day (the claim, src/db/reconcile.ts), a few per account per run, within
// a budget of platform calls per run: a repository the budget cut short
// is given back and read again by the next run.

export type Reconciler = {
  db: Db;
  env: Pick<AppBindings, "MASTER_KEY" | "MASTER_KEY_PREVIOUS">;
  platforms: readonly CodePlatform[];
  bots?: BotTokens | undefined;
  /** Platform calls one run may make, tokens included; never fewer than one repository's most. */
  calls: number;
};

/**
 * The Worker's calls per run: the Workers Free plan allows 50 external
 * subrequests per invocation, and the hourly cron's other work (deliveries,
 * digests, reports, reminders, held notices, stack merges) shares them.
 */
export const WORKER_RECONCILE_CALLS = 20;
/** The Node server's calls per run, where only the platforms' own rate limits bound them. */
export const NODE_RECONCILE_CALLS = 200;

/** Repositories read per run: 24 runs a day read 240 a day. */
const REPOS_PER_RUN = 10;
/** Repositories of one account per run, so no account's many wait out the others'. */
const PER_ACCOUNT_PER_RUN = 2;
/** Pages of a hundred, of closed and of open pull requests each. */
const PAGES_PER_LIST = 2;
/** Pull requests read one by one per repository: held open here, not listed open there. */
const SINGLE_READS = 10;
/** Closes this far back are filled in: a day, and two more for runs that did not happen. */
const WINDOW_MS = 3 * 24 * 60 * 60_000;
/** Flows held open read per repository. */
const LOOKS_OPEN_CAP = 500;
/** A GitHub bot token: the App, its installation and the token; then the link's refresh when refused. */
const BOT_TOKEN_CALLS = 4;
/** The link's token, refreshed when it expired. */
const LINK_TOKEN_CALLS = 1;
/** What a repository is started with at least: a token and one page of each listing. */
const FEWEST_CALLS_PER_REPO = BOT_TOKEN_CALLS + 2;
/** What one repository can take, so a budget of this many finishes any repository. */
const MOST_CALLS_PER_REPO = BOT_TOKEN_CALLS + 2 * PAGES_PER_LIST + SINGLE_READS;

type ReconcileOutcome =
  | { state: "done"; closes: number; flows: number }
  | { state: "no_platform" | "no_token" | "unreachable" | "cut" };

/** Reads the repositories due, fairly across accounts; how many it claimed. */
export async function reconcileRepos(r: Reconciler, now = new Date()): Promise<number> {
  const taken = new Map<string, number>();
  let round: string[] = [];
  let claimed = 0;
  const calls = new CallBudget(Math.max(r.calls, MOST_CALLS_PER_REPO));
  while (claimed < REPOS_PER_RUN && calls.left >= FEWEST_CALLS_PER_REPO) {
    const full = [...taken].filter(([, n]) => n >= PER_ACCOUNT_PER_RUN).map(([a]) => a);
    const turn = await claimReconcile(r.db, now, [...new Set([...round, ...full])]);
    if (!turn) {
      // Every account had its turn this round: the next round starts over.
      if (round.length === 0) break;
      round = [];
      continue;
    }
    claimed++;
    round.push(turn.accountId);
    taken.set(turn.accountId, (taken.get(turn.accountId) ?? 0) + 1);
    try {
      const outcome = await reconcileRepo(r, turn, calls, now);
      if (outcome.state === "cut") await releaseReconcile(r.db, turn);
      else if (outcome.state !== "done") logError("reconcile_skipped", { reason: outcome.state });
    } catch (e) {
      logError("reconcile_failed", { error: errorName(e) });
    }
  }
  return claimed;
}

/** One claimed repository, read and filled in. */
async function reconcileRepo(
  r: Reconciler,
  repo: ReconcileTurn,
  calls: CallBudget,
  now = new Date(),
): Promise<ReconcileOutcome> {
  const platform = r.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  if (!platform) return { state: "no_platform" };
  const tokenCalls = r.bots && repo.platform === "github" ? BOT_TOKEN_CALLS : LINK_TOKEN_CALLS;
  if (!calls.take(tokenCalls)) return { state: "cut" };
  const data = scoped(r.db, repo.accountId);
  const bot = r.bots ? await r.bots.forRepo(repo.platform, repo.fullName) : null;
  const token = bot?.token ?? (await accessToken(data, r.env, platform));
  if (!token) return { state: "no_token" };
  const read = platform.reconcile;
  const since = new Date(Math.max(now.getTime() - WINDOW_MS, repo.createdAt.getTime()));
  const [closed, open] = await Promise.all([
    read.closedSince(token, repo.fullName, since, PAGES_PER_LIST, calls),
    read.open(token, repo.fullName, PAGES_PER_LIST, calls),
  ]);
  if (closed === "spent" || open === "spent") return { state: "cut" };
  if (!closed || !open) return { state: "unreachable" };
  const fill = new Fill(data, repo);

  const closedBy = new Map<number, ReconciledPull>();
  for (const p of closed.pulls) {
    closedBy.set(p.number, p);
    if (p.closedAt && p.closedAt >= repo.createdAt) await fill.close(p, "unless_recorded");
  }

  const held = new Map(
    (await data.pullFlows.looksOpen(repo.id, LOOKS_OPEN_CAP)).map((f) => [f.number, f]),
  );
  const openNow = new Set<number>();
  for (const p of open.pulls) {
    openNow.add(p.number);
    const flow = held.get(p.number);
    // A pull request last changed before the repository was enrolled has no flow to fill.
    const changed = p.updatedAt ?? now;
    if (flow ? flow.draft !== p.draft : changed >= repo.createdAt) await fill.flow(p, changed);
  }

  let reads = 0;
  for (const number of held.keys()) {
    if (openNow.has(number)) continue;
    let p: ReconciledPull | "missing" | "spent" | null | undefined = closedBy.get(number);
    if (!p) {
      if (reads >= SINGLE_READS) continue;
      reads++;
      p = await read.one(token, repo.fullName, number, calls);
      // What it filled stands; the next run reads the repository again.
      if (p === "spent") return { state: "cut" };
    }
    if (p && p !== "missing" && p.state !== "open") await fill.close(p, "if_newer");
  }
  return { state: "done", closes: fill.closes, flows: fill.flows };
}

/** The writes of one repository's run, counted. */
class Fill {
  closes = 0;
  flows = 0;
  constructor(
    private readonly data: Scoped,
    private readonly repo: ReconcileTurn,
  ) {}

  /**
   * A close the webhook did not record: `unless_recorded` leaves any close
   * on record as it is; `if_newer` replaces one only with a later close,
   * as the webhook's record does after a reopen.
   */
  async close(p: ReconciledPull, mode: "unless_recorded" | "if_newer"): Promise<void> {
    if (!p.closedAt) return;
    const close = {
      reviewRepoId: this.repo.id,
      number: p.number,
      title: p.title,
      merged: p.state === "merged",
      openedAt: p.openedAt,
      closedAt: p.closedAt,
    };
    if (mode === "unless_recorded") {
      if (await this.data.closedPulls.fill(close)) this.closes++;
    } else {
      await this.data.closedPulls.record(close);
      this.closes++;
    }
  }

  /** The open pull request as the platform has it, merged as a webhook event of when it last changed. */
  async flow(p: ReconciledPull, changed: Date): Promise<void> {
    await this.data.pullFlows.record({
      reviewRepoId: this.repo.id,
      number: p.number,
      title: p.title,
      author: p.author,
      authorId: p.authorId,
      draft: p.draft,
      size: null,
      openedAt: p.openedAt,
      seenAt: changed,
    });
    this.flows++;
  }
}
