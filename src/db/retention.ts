import { and, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { errorName, logError } from "../log.js";
import { FEED_DAYS } from "../shared/index.js";
import { DAY, utcDay } from "../time.js";
import type { Db } from "./client.js";
import { expireUnconfirmed, HELD_FOR } from "./notify.js";
import {
  accounts,
  apiTokens,
  auditEvents,
  automationAssignments,
  automationRuns,
  closedPulls,
  deviceCodes,
  findingThreads,
  gatewayCalls,
  generateJobs,
  inboundEvents,
  learnJobs,
  liveRuns,
  mergeCheckRuns,
  mergeIntents,
  notificationFeed,
  notifyDeliveries,
  notifyHeld,
  notifySends,
  pullCommands,
  pullFileViews,
  pullFlows,
  pullImpacts,
  pullIndex,
  pullPaths,
  pullReviews,
  pullSeen,
  rateWindows,
  releaseDrafts,
  replyJobs,
  restackJobs,
  reviewJobs,
  reviewRequests,
  reviews,
  reviewTeams,
  reviewThreads,
  scheduledReportSends,
  serviceCounters,
  sessions,
  stackMerges,
  usageCounters,
} from "./schema.js";
import { scoped } from "./scoped.js";

// What the data policy (web /privacy) promises: review records, live runs, gateway call
// records, merged and closed pull requests, the periods scheduled reports sent, their review flow, the inbox's index of pull requests (closed ones after PULL_INDEX_CLOSED_DAYS), review threads and the threads of ocra's findings, who a rule assigned to review them, the inbox's read marks, the finished jobs of auto review (reviews, answers, generated
// tests and docs), the pre-merge checks' results, the daily counts and the audit log are deleted after
// RETENTION_DAYS; expired login codes, sessions and API tokens go at once; a notice held in
// quiet hours after HELD_FOR; a channel's delivery record after DELIVERY_DAYS, a platform's
// delivery to us after INBOUND_EVENT_DAYS, a team's members TEAM_DAYS after
// they were read, a channel never confirmed UNCONFIRMED_DAYS after its last link, a
// notification centre's notice after FEED_DAYS, a held release draft RETENTION_DAYS after its
// last save. Runs daily
// from the cron trigger.

export const RETENTION_DAYS = 90;
/** An automation's run is kept for a month: enough to see why a rule acted. */
export const AUTOMATION_RUN_DAYS = 30;
/** A merge-when-ready intent that ended, kept to show how it ended. */
const MERGE_INTENT_DAYS = 30;
/** A pull request event's claim, long past any webhook's redelivery. */
const NOTIFY_SEND_DAYS = 30;
/** A webhook delivery's record: its retries end within hours. */
const DELIVERY_DAYS = 30;

/** A team's members as read: a newer ask reads them again after a day (src/auto-review/teams.ts). */
const TEAM_DAYS = 30;

/**
 * A closed pull request in the inbox's index: past the week of merges the
 * inbox lists. An open one untouched for RETENTION_DAYS goes too; the
 * reconciliation reads it in again while it is open.
 */
const PULL_INDEX_CLOSED_DAYS = 8;

/** A platform's delivery: its retries end within the hour, and platforms redeliver within days. */
const INBOUND_EVENT_DAYS = 7;

/**
 * Runs every delete, each on its own: one that fails is logged and the rest
 * still run. Throws at the end, naming the deletes that failed, so the cron
 * run shows as failed. Only our own message is logged, never the error's
 * text, which could quote a row.
 */
export async function enforceRetention(db: Db, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
  // Account by account, so a delete finds its rows through the index that
  // starts with account_id instead of reading the whole table (audit C3).
  const ofEachAccount = (column: SQLiteColumn) =>
    inArray(column, db.select({ id: accounts.id }).from(accounts));
  // A job that ended, by when it did; one queued or running is never deleted.
  const ended = (
    job:
      | typeof reviewJobs
      | typeof replyJobs
      | typeof generateJobs
      | typeof learnJobs
      | typeof restackJobs,
  ) =>
    db.delete(job).where(
      and(
        ofEachAccount(job.accountId),
        // It ended after it was made: the index on created_at finds the old ones.
        lt(job.createdAt, cutoff),
        lt(job.finishedAt, cutoff),
        notInArray(job.state, ["queued", "running"]),
      ),
    );
  const deletes: [string, () => Promise<unknown>][] = [
    // A review's findings go with it (foreign key cascade, by findings_review).
    [
      "reviews",
      () =>
        db
          .delete(reviews)
          .where(and(ofEachAccount(reviews.accountId), lt(reviews.createdAt, cutoff))),
    ],
    // A live run's events, grants and comments go with it (cascade).
    [
      "live_runs",
      () =>
        db
          .delete(liveRuns)
          .where(and(ofEachAccount(liveRuns.accountId), lt(liveRuns.updatedAt, cutoff))),
    ],
    [
      "gateway_calls",
      () =>
        db
          .delete(gatewayCalls)
          .where(and(ofEachAccount(gatewayCalls.accountId), lt(gatewayCalls.createdAt, cutoff))),
    ],
    [
      "audit_events",
      () =>
        db
          .delete(auditEvents)
          .where(and(ofEachAccount(auditEvents.accountId), lt(auditEvents.createdAt, cutoff))),
    ],
    [
      "closed_pulls",
      () =>
        db
          .delete(closedPulls)
          .where(and(ofEachAccount(closedPulls.accountId), lt(closedPulls.closedAt, cutoff))),
    ],
    [
      "pull_flows",
      () =>
        db
          .delete(pullFlows)
          .where(and(ofEachAccount(pullFlows.accountId), lt(pullFlows.seenAt, cutoff))),
    ],
    [
      "pull_index",
      () =>
        db
          .delete(pullIndex)
          .where(
            and(
              ofEachAccount(pullIndex.accountId),
              or(
                and(
                  inArray(pullIndex.state, ["closed", "merged"]),
                  lt(pullIndex.changedAt, new Date(now.getTime() - PULL_INDEX_CLOSED_DAYS * DAY)),
                ),
                and(eq(pullIndex.state, "open"), lt(pullIndex.changedAt, cutoff)),
              ),
            ),
          ),
    ],
    [
      "pull_reviews",
      () =>
        db
          .delete(pullReviews)
          .where(and(ofEachAccount(pullReviews.accountId), lt(pullReviews.submittedAt, cutoff))),
    ],
    [
      "review_threads",
      () =>
        db
          .delete(reviewThreads)
          .where(and(ofEachAccount(reviewThreads.accountId), lt(reviewThreads.seenAt, cutoff))),
    ],
    [
      "finding_threads",
      () =>
        db
          .delete(findingThreads)
          .where(and(ofEachAccount(findingThreads.accountId), lt(findingThreads.seenAt, cutoff))),
    ],
    [
      "pull_impacts",
      () =>
        db
          .delete(pullImpacts)
          .where(and(ofEachAccount(pullImpacts.accountId), lt(pullImpacts.createdAt, cutoff))),
    ],
    [
      "review_requests",
      () =>
        db
          .delete(reviewRequests)
          .where(
            and(ofEachAccount(reviewRequests.accountId), lt(reviewRequests.requestedAt, cutoff)),
          ),
    ],
    [
      "review_teams",
      () =>
        db
          .delete(reviewTeams)
          .where(
            and(
              ofEachAccount(reviewTeams.accountId),
              lt(reviewTeams.fetchedAt, new Date(now.getTime() - TEAM_DAYS * DAY)),
            ),
          ),
    ],
    ["review_jobs", () => ended(reviewJobs)],
    ["reply_jobs", () => ended(replyJobs)],
    ["generate_jobs", () => ended(generateJobs)],
    ["learn_jobs", () => ended(learnJobs)],
    ["restack_jobs", () => ended(restackJobs)],
    [
      "pull_commands",
      () =>
        db
          .delete(pullCommands)
          .where(and(ofEachAccount(pullCommands.accountId), lt(pullCommands.createdAt, cutoff))),
    ],
    // A head's result, by when it was last posted: one evaluated again is posted again.
    [
      "merge_check_runs",
      () =>
        db
          .delete(mergeCheckRuns)
          .where(
            and(
              ofEachAccount(mergeCheckRuns.accountId),
              lt(mergeCheckRuns.createdAt, cutoff),
              sql`coalesce(${mergeCheckRuns.postedAt}, ${mergeCheckRuns.createdAt}) < ${cutoff.getTime()}`,
            ),
          ),
    ],
    // A pull request not seen for that long falls back on the inbox baseline,
    // which is never older than the cutoff (./pull-seen.ts): read until it changes.
    [
      "pull_seen",
      () =>
        db
          .delete(pullSeen)
          .where(and(ofEachAccount(pullSeen.accountId), lt(pullSeen.seenAt, cutoff))),
    ],
    [
      "pull_file_views",
      () =>
        db
          .delete(pullFileViews)
          .where(and(ofEachAccount(pullFileViews.accountId), lt(pullFileViews.viewedAt, cutoff))),
    ],
    [
      "pull_paths",
      () =>
        db
          .delete(pullPaths)
          .where(and(ofEachAccount(pullPaths.accountId), lt(pullPaths.seenAt, cutoff))),
    ],
    [
      "automation_runs",
      () =>
        db
          .delete(automationRuns)
          .where(
            and(
              ofEachAccount(automationRuns.accountId),
              lt(automationRuns.createdAt, new Date(now.getTime() - AUTOMATION_RUN_DAYS * DAY)),
            ),
          ),
    ],
    [
      "scheduled_report_sends",
      () =>
        db
          .delete(scheduledReportSends)
          .where(
            and(
              ofEachAccount(scheduledReportSends.accountId),
              lt(scheduledReportSends.createdAt, cutoff),
            ),
          ),
    ],
    [
      "automation_assignments",
      () =>
        db
          .delete(automationAssignments)
          .where(
            and(
              ofEachAccount(automationAssignments.accountId),
              lt(automationAssignments.createdAt, cutoff),
            ),
          ),
    ],
    [
      "notify_sends",
      () =>
        db
          .delete(notifySends)
          .where(
            and(
              ofEachAccount(notifySends.accountId),
              lt(notifySends.createdAt, new Date(now.getTime() - NOTIFY_SEND_DAYS * DAY)),
            ),
          ),
    ],
    [
      "notification_feed",
      () =>
        db
          .delete(notificationFeed)
          .where(
            and(
              ofEachAccount(notificationFeed.accountId),
              lt(notificationFeed.createdAt, new Date(now.getTime() - FEED_DAYS * DAY)),
            ),
          ),
    ],
    [
      "release_drafts",
      () =>
        db
          .delete(releaseDrafts)
          .where(and(ofEachAccount(releaseDrafts.accountId), lt(releaseDrafts.updatedAt, cutoff))),
    ],
    [
      "notify_held",
      () =>
        db
          .delete(notifyHeld)
          .where(
            and(
              ofEachAccount(notifyHeld.accountId),
              lt(notifyHeld.createdAt, new Date(now.getTime() - HELD_FOR)),
            ),
          ),
    ],
    [
      "notify_deliveries",
      () =>
        db
          .delete(notifyDeliveries)
          .where(
            and(
              ofEachAccount(notifyDeliveries.accountId),
              lt(notifyDeliveries.createdAt, new Date(now.getTime() - DELIVERY_DAYS * DAY)),
            ),
          ),
    ],
    // An armed intent untouched since the retention window goes too (it is
    // older than the month as well, which the index on updated_at finds).
    [
      "merge_intents",
      () =>
        db
          .delete(mergeIntents)
          .where(
            and(
              ofEachAccount(mergeIntents.accountId),
              lt(mergeIntents.updatedAt, new Date(now.getTime() - MERGE_INTENT_DAYS * DAY)),
              or(
                notInArray(mergeIntents.state, ["armed", "merging"]),
                lt(mergeIntents.updatedAt, cutoff),
              ),
            ),
          ),
    ],
    // Shared: it may be no account's (src/db/inbound-events.ts).
    [
      "inbound_events",
      () =>
        db
          .delete(inboundEvents)
          .where(lt(inboundEvents.createdAt, new Date(now.getTime() - INBOUND_EVENT_DAYS * DAY))),
    ],
    // A merge under way times out within days (src/stack-merge/advance.ts): one older is abandoned.
    [
      "stack_merges",
      () =>
        db
          .delete(stackMerges)
          .where(
            and(
              ofEachAccount(stackMerges.accountId),
              lt(stackMerges.updatedAt, new Date(now.getTime() - MERGE_INTENT_DAYS * DAY)),
            ),
          ),
    ],
    ["notify_channels", () => expireChannels(db, now)],
    // DEVICE_DAILY_CODES a day at most, so they are read whole.
    ["device_codes", () => db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now))],
    // Only today's counts are used, and some are per network: the rest go.
    [
      "service_counters",
      () => db.delete(serviceCounters).where(lt(serviceCounters.day, utcDay(now))),
    ],
    // A window lasts a minute or so; a day later it is long over.
    [
      "rate_windows",
      () => db.delete(rateWindows).where(lt(rateWindows.start, now.getTime() - DAY)),
    ],
    // A session ends with its last token: for the CLI, the refresh token
    // (the sessions_ends index).
    [
      "sessions",
      () =>
        db
          .delete(sessions)
          .where(
            sql`coalesce(${sessions.refreshExpiresAt}, ${sessions.expiresAt}) < ${now.getTime()}`,
          ),
    ],
    // A token past its expiry is refused already; its row goes at once.
    ["api_tokens", () => db.delete(apiTokens).where(lt(apiTokens.expiresAt, now))],
    [
      "usage_counters",
      () =>
        db
          .delete(usageCounters)
          .where(
            and(
              ofEachAccount(usageCounters.accountId),
              inArray(usageCounters.kind, usageCounters.kind.enumValues),
              lt(usageCounters.day, utcDay(cutoff)),
            ),
          ),
    ],
  ];
  const failed: string[] = [];
  for (const [table, run] of deletes) {
    try {
      await run();
    } catch (e) {
      failed.push(table);
      logError("retention_failed", { table, error: errorName(e) });
    }
  }
  if (failed.length > 0) throw new Error(`retention failed for: ${failed.join(", ")}`);
}

/** Deletes the channels never confirmed, with what they held, each in its account's audit log. */
async function expireChannels(db: Db, now: Date): Promise<void> {
  for (const { id, accountId, kind } of await expireUnconfirmed(db, now)) {
    const data = scoped(db, accountId);
    await data.removeWhere("notifyHeld", { channelId: id });
    await data.deliveries.drop([id]);
    await data.insert("auditEvents", {
      kind: "channel.expired",
      detail: { channel: id, kind },
      createdAt: now,
    });
  }
}
