import { type FixOutcome, type FixReason, redactField } from "@open-cr-agent/cloud-contract";
import type { FeedNotice } from "../db/notification-feed.js";
import type { Row, Scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { pullOfReview } from "../review-pull.js";
import {
  type CodePlatformKind,
  FEED_KINDS,
  type FeedKind,
  type NotifyEvent,
  pullPath,
} from "../shared/index.js";
import { plain } from "./channels.js";
import type { PullEvent } from "./pull-events.js";

// The notification centre's notices, made where the events they tell of are
// decided, and kept whether or not a channel hears of them. A notice's
// text is made plain and redacted, and stops at MAX_SUBTITLE characters:
// a comment reaches it only as the excerpt its channel notice carries.

const MAX_SUBTITLE = 240;
/** A finding's title as a fix's notice quotes it. */
const MAX_FIX_TITLE = 120;

type Place = { platform: CodePlatformKind; fullName: string };

const isFeedKind = (kind: NotifyEvent | FeedKind): kind is FeedKind =>
  (FEED_KINDS as readonly string[]).includes(kind);

/** Plain, redacted and short: what a notice's subtitle may hold. */
function subtitleOf(lines: readonly string[]): string | null {
  const text = lines
    .map((l) => plain(redactField(l.replace(/^•\s*/, "")).text))
    .filter((l) => l !== "")
    .join(" · ");
  const chars = [...text];
  if (chars.length === 0) return null;
  return chars.length > MAX_SUBTITLE ? `${chars.slice(0, MAX_SUBTITLE - 1).join("")}…` : text;
}

/** The notices of the account's own user's pull request events, kinds the centre keeps only. */
export function pullEventNotices(repo: Place, events: readonly PullEvent[], now: Date) {
  // Events of one comment share its key: the first, the most specific, is the one kept.
  const firstOfKey = events.filter((e, i) => events.findIndex((o) => o.key === e.key) === i);
  return firstOfKey.flatMap((e): FeedNotice[] =>
    isFeedKind(e.kind)
      ? [
          {
            eventKey: e.key,
            kind: e.kind,
            title: e.what,
            subtitle: subtitleOf(e.more ?? []),
            link: pullPath(repo.platform, repo.fullName, e.number),
            repo: repo.fullName,
            number: e.number,
            createdAt: now,
          },
        ]
      : [],
  );
}

/**
 * Keeps the notices; a failure is logged, never thrown, so that a channel
 * still hears of the event.
 */
export async function keepNotices(data: Scoped, notices: readonly FeedNotice[]): Promise<void> {
  try {
    await data.feed.record(notices);
  } catch (e) {
    logError("feed_record_failed", { error: errorName(e) });
  }
}

/**
 * A stored review of a pull request; its key is the one of its critical
 * finding's notice (./pull-events.ts), so its author, told of that, is not
 * told twice.
 */
export function reviewNotice(review: Row<"reviews">): FeedNotice | null {
  const pull = pullOfReview(review);
  if (!pull) return null;
  const found =
    review.findings === 0
      ? "no findings"
      : `${review.findings} finding${review.findings === 1 ? "" : "s"}${
          review.critical > 0 ? `, ${review.critical} critical` : ""
        }`;
  return {
    eventKey: `review:${review.id}`,
    kind: "review_finished",
    title: `ocra reviewed ${plain(pull.repo)}#${pull.number}`,
    subtitle: found,
    link: `/reviews/${encodeURIComponent(review.id)}`,
    repo: pull.repo,
    number: pull.number,
  };
}

/** A rule's notify action on a pull request, once per rule and event. */
export function automationNotice(
  rule: Pick<Row<"automationRules">, "id" | "name">,
  eventKey: string,
  pull: { fullName: string; number: number },
  platform: CodePlatformKind | undefined,
): FeedNotice {
  return {
    eventKey: `automation:${rule.id}:${eventKey}`,
    kind: "automation",
    title: plain(`Rule “${rule.name}” ran`),
    subtitle: `${plain(pull.fullName)}#${pull.number}`,
    link: platform ? pullPath(platform, pull.fullName, pull.number) : "/automations",
    repo: pull.fullName,
    number: pull.number,
  };
}

/** What `ocra fix` answered a request for a fix of the finding: it opens the finding's review. */
export function fixNotice(
  job: { id: string; outcome: FixOutcome; reason: FixReason | null; finishedAt: Date },
  finding: { title: string; reviewId: string },
  repo: { fullName: string },
  number: number,
): FeedNotice {
  const chars = [...plain(redactField(finding.title).text)];
  const title =
    chars.length > MAX_FIX_TITLE
      ? `${chars.slice(0, MAX_FIX_TITLE - 1).join("")}…`
      : chars.join("");
  return {
    eventKey: `fix:${job.id}@${job.finishedAt.getTime()}`,
    kind: "fix_finished",
    title:
      job.outcome === "proposed"
        ? `ocra proposed a fix for “${title}”`
        : `ocra wrote no fix for “${title}”`,
    subtitle: `${plain(repo.fullName)}#${number}${
      job.outcome === "proposed" ? "" : ` · ${job.outcome}${job.reason ? ` (${job.reason})` : ""}`
    }`,
    link: `/reviews/${encodeURIComponent(finding.reviewId)}`,
    repo: repo.fullName,
    number,
    createdAt: job.finishedAt,
  };
}

const JOB_NOUN = {
  review: "review",
  reply: "answer to a comment",
  generate: "draft",
  learn: "learning run",
  fix: "fix",
} as const;

/** A hosted job that gave up, once per time it did. */
function jobFailedNotice(
  job: { kind: keyof typeof JOB_NOUN; id: string; number: number; finishedAt: Date },
  repo: Place,
): FeedNotice {
  return {
    eventKey: `job:${job.kind}:${job.id}@${job.finishedAt.getTime()}`,
    kind: "job_failed",
    title: `ocra’s ${JOB_NOUN[job.kind]} could not finish`,
    subtitle: `${plain(repo.fullName)}#${job.number}`,
    link: pullPath(repo.platform, repo.fullName, job.number),
    repo: repo.fullName,
    number: job.number,
    createdAt: job.finishedAt,
  };
}

const JOB_TABLE = {
  review: "reviewJobs",
  reply: "replyJobs",
  generate: "generateJobs",
  learn: "learnJobs",
  fix: "fixJobs",
} as const;

/** Keeps a notice of the hosted job when it has just given up (failed, at now); never throws. */
export async function noteFailedJob(
  data: Scoped,
  kind: keyof typeof JOB_NOUN,
  id: string,
  now: Date,
): Promise<void> {
  try {
    const job = await data.get(JOB_TABLE[kind], id);
    if (job?.state !== "failed" || job.finishedAt?.getTime() !== now.getTime()) return;
    const repo = await data.get("reviewRepos", job.reviewRepoId);
    if (!repo) return;
    const notice = jobFailedNotice({ kind, id, number: job.number, finishedAt: now }, repo);
    await data.feed.record([notice]);
  } catch (e) {
    logError("feed_record_failed", { error: errorName(e) });
  }
}
