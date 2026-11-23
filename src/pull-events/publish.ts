import type { Context } from "hono";
import { touchPulls } from "../db/pull-changes.js";
import { defer } from "../defer.js";
import { platformsOf } from "../platforms/registry.js";
import type { PullsTouched } from "../pull-changes.js";
import { pullOfReview, pullOnPlatform } from "../review-pull.js";
import type { PullsChangedEvent } from "../shared/index.js";
import type { AppEnv } from "../types.js";

// What moves an account's inbox change time (../db/pull-changes.ts) tells
// its open consoles here, so none moves it unheard: a webhook about a pull
// request of an enrolled repository, and a review of the account's arriving
// (test/pull-events-publish.test.ts holds every caller to it).

type Platform = Parameters<typeof touchPulls>[1];

/** Moves the repository's change time for a webhook, and tells the accounts it moved after the answer. */
export async function touchAndPublish(
  c: Context<AppEnv>,
  platform: Platform,
  host: string,
  platformRepoId: string,
  touched: PullsTouched,
): Promise<void> {
  const moved = await touchPulls(c.var.db, platform, host, platformRepoId, new Date());
  const numbers = touched.numbers.length > 0 ? touched.numbers : [null];
  for (const { accountId, repoId } of moved) {
    publish(
      c,
      accountId,
      numbers.map((number) => ({ repoId, number, kind: touched.kind })),
    );
  }
}

/**
 * Tells the account's open consoles, after the answer, that its review
 * `id` arrived: of a pull request of a repository it enrolled on a platform
 * this deployment serves when the review names one, of no repository
 * otherwise. Its newest review moves the change time either way.
 */
export function publishReview(c: Context<AppEnv>, id: string): void {
  const hub = c.var.pullsHub;
  if (!hub) return;
  defer(
    c,
    reviewEvent(c, id).then((event) => event && hub.publish(c.var.data.accountId, [event])),
  );
}

async function reviewEvent(c: Context<AppEnv>, id: string): Promise<PullsChangedEvent | null> {
  const review = await c.var.data.get("reviews", id);
  if (!review) return null;
  const reviewed = pullOfReview(review);
  const on = reviewed && pullOnPlatform(platformsOf(c.env, c.req.url), reviewed);
  const repo =
    on &&
    (await c.var.data.mergeChecks.enrolledRepo(on.platform.kind, on.platform.host, on.pull.repo));
  return repo && on
    ? { repoId: repo.id, number: on.pull.number, kind: "review" }
    : { repoId: null, number: null, kind: "review" };
}

function publish(c: Context<AppEnv>, accountId: string, events: PullsChangedEvent[]): void {
  const hub = c.var.pullsHub;
  if (hub) defer(c, hub.publish(accountId, events));
}
