import type { Db } from "../db/client.js";
import type { IndexedRepo, IndexRow } from "../db/pull-index.js";
import type { Scoped } from "../db/scoped.js";
import { ownUser } from "../notify/pull-events.js";
import type { CodePlatform } from "../platforms/platform.js";
import {
  type ListedPull,
  MERGED_PER_LIST,
  mergedSince,
  OPEN_PER_LIST,
  type PlatformPull,
  type PullListing,
  pullKey,
  type TeamAsk,
  withRoles,
} from "../platforms/pulls.js";
import { applyFacts, mergeFacts, type PullFacts } from "./facts.js";
import { freshRepo } from "./fresh.js";

// The inbox read from the index (pull_index) in place of the platform.
// The inbox lists the user's pulls in every repository they reach, and the
// index holds only the account's enrolled ones, so it answers for a
// platform only while a live listing vouches for it: one read at most
// VERIFIED_FOR_MS ago that held no pull of the user outside the
// repositories the index is fresh for (./fresh.ts), and matched, pull for
// pull and role for role, what the index answered then. A webhook it
// cannot follow since (./hooks.ts) sends the next load to the platform.
// Each live listing fills the index with what it read of the user's pulls
// in enrolled repositories (checks and review decision only come from
// there) and vouches for it again when they match.

/** How long a matching live listing vouches for the index: a pull in a repository not enrolled waits at most this long. */
const VERIFIED_FOR_MS = 5 * 60_000;

/** At most this many of the user's rows are read: more than the listing's lists hold sends it to the platform. */
const MOST_ROWS = 3 * OPEN_PER_LIST + MERGED_PER_LIST + 1;

type View = { pulls: PlatformPull[]; rows: { row: IndexRow; repo: IndexedRepo }[] };

/** The user's listing from the index, or null when the platform must be read. */
export async function indexedListing(
  db: Db,
  data: Scoped,
  platform: CodePlatform,
  asks: readonly TeamAsk[],
  now = new Date(),
): Promise<PullListing | null> {
  const state = await data.pullIndex.state(platform.kind, platform.host);
  const verified = state?.verifiedAt;
  if (!verified || now.getTime() - verified.getTime() > VERIFIED_FOR_MS) return null;
  if (state.staleAt && state.staleAt >= verified) return null;
  const me = await ownUser(db, data, { platform: platform.kind, host: platform.host });
  if (!me) return null;
  const view = await indexView(data, platform, me.id, asks, now);
  return view && { pulls: view.pulls, more: false };
}

async function indexView(
  data: Scoped,
  platform: CodePlatform,
  userId: string,
  asks: readonly TeamAsk[],
  now: Date,
): Promise<View | null> {
  const repos = await data.pullIndex.repos(platform.kind, platform.host);
  const byId = new Map(repos.map((r) => [r.id, r]));
  const byName = new Map(repos.map((r) => [r.fullName.toLowerCase(), r]));
  // As each platform's own list of merges: GitLab's by update time, GitHub's from the start of a UTC day.
  const from = mergedSince(now.getTime());
  const gitlab = platform.kind === "gitlab";
  const since = gitlab ? from : new Date(`${from.toISOString().slice(0, 10)}T00:00:00Z`);
  const mergedBy = gitlab ? "changedAt" : "mergedAt";
  const mine = await data.pullIndex.mine(
    platform.kind,
    platform.host,
    userId,
    since,
    mergedBy,
    MOST_ROWS,
  );
  if (mine.length >= MOST_ROWS) return null;
  const asked = asks.flatMap((a) => {
    const repo = byName.get(a.repo.toLowerCase());
    return repo ? [{ reviewRepoId: repo.id, number: a.number }] : [];
  });
  if (asked.length < asks.length) return null;
  const teamRows = (await data.pullIndex.byNumbers(asked)).filter((r) => r.state === "open");
  const rows: View["rows"] = [];
  for (const row of [...mine, ...teamRows]) {
    const repo = byId.get(row.reviewRepoId);
    if (!repo || !freshRepo(repo, now)) return null;
    rows.push({ row, repo });
  }
  const open = rows.filter(({ row }) => row.state === "open");
  const review = [
    ...open.filter(({ row }) => row.reviewerIds.includes(userId)),
    ...rows.slice(mine.length),
  ];
  const authored = open.filter(({ row }) => row.authorId === userId);
  const assigned = open.filter(({ row }) => row.assigneeIds.includes(userId));
  const merged = rows.slice(0, mine.length).filter(({ row }) => row.state === "merged");
  if (
    [review, authored, assigned].some((l) => l.length > OPEN_PER_LIST) ||
    merged.length > MERGED_PER_LIST
  ) {
    return null;
  }
  const item = ({ row, repo }: View["rows"][number]) => listedOf(platform, row, repo);
  return {
    pulls: withRoles([
      { role: "reviewer", pulls: review.map(item) },
      { role: "author", pulls: [...authored, ...merged].map(item) },
      { role: "assignee", pulls: assigned.map(item) },
    ]),
    rows,
  };
}

/** A time as the platform's listing writes it: GitHub's to the second, GitLab's to the millisecond. */
const timeText = (platform: CodePlatform, at: Date) =>
  platform.kind === "github" ? at.toISOString().replace(/\.000Z$/, "Z") : at.toISOString();

function listedOf(platform: CodePlatform, row: IndexRow, repo: IndexedRepo): ListedPull {
  const time = (at: Date) => timeText(platform, at);
  return {
    id: row.pullId ?? `${repo.fullName}#${row.number}`,
    number: row.number,
    title: row.title,
    url: row.url,
    repo: repo.fullName,
    author: row.author,
    authorAvatar: row.authorAvatar,
    draft: row.draft,
    state: row.state === "merged" ? "merged" : "open",
    createdAt: time(row.openedAt),
    updatedAt: time(row.changedAt),
    mergedAt: row.mergedAt ? time(row.mergedAt) : null,
    checks: row.checks,
    review: row.review,
    labels: row.labels,
    additions: row.additions,
    deletions: row.deletions,
    head: row.head,
    branches:
      row.headBranch && row.baseBranch ? { head: row.headBranch, base: row.baseBranch } : null,
  };
}

const withMe = (ids: readonly string[], me: string, on: boolean) =>
  on ? (ids.includes(me) ? [...ids] : [...ids, me]) : ids.filter((id) => id !== me);

/** What the live listing says of one of the user's pulls, and of their part in it. */
function liveFacts(
  p: PlatformPull,
  read: IndexRow | undefined,
  me: string,
  throughTeam: boolean,
): PullFacts | null {
  const changedAt = new Date(p.updatedAt);
  if (!Number.isFinite(changedAt.getTime())) return null;
  const reviewers = read?.reviewerIds ?? [];
  const assignees = read?.assigneeIds ?? [];
  return {
    number: p.number,
    changedAt,
    // A pull listed without the platform's id has one made of its name.
    ...(p.id.includes("#") ? {} : { pullId: p.id }),
    title: p.title,
    url: p.url,
    author: p.author,
    ...(p.roles.includes("author") ? { authorId: me } : {}),
    authorAvatar: p.authorAvatar,
    draft: p.draft,
    state: p.state,
    openedAt: new Date(p.createdAt),
    mergedAt: p.mergedAt ? new Date(p.mergedAt) : null,
    labels: p.labels,
    additions: p.additions,
    deletions: p.deletions,
    head: p.head,
    branches: p.branches,
    checks: p.checks,
    review: p.review,
    // Asked through a team is the team's ask (review_requests), not the user's own.
    reviewerIds: throughTeam ? reviewers : withMe(reviewers, me, p.roles.includes("reviewer")),
    // A listing names assignee only where no other role holds.
    assigneeIds: p.roles.includes("assignee") ? withMe(assignees, me, true) : assignees,
  };
}

const rolesOf = (pulls: readonly PlatformPull[]) =>
  new Map(
    pulls.map((p) => [pullKey(p.repo, p.number), `${p.state}:${[...p.roles].sort().join(",")}`]),
  );

/**
 * After a live listing read from `readAt`: keeps what it says of the user's
 * pulls in enrolled repositories, takes the user off pulls the index still
 * had them on, and vouches for the index when it now answers the same.
 */
export async function verifyListing(
  db: Db,
  data: Scoped,
  platform: CodePlatform,
  listing: PullListing,
  asks: readonly TeamAsk[],
  readAt: Date,
  now = new Date(),
): Promise<void> {
  const repos = await data.pullIndex.repos(platform.kind, platform.host);
  if (repos.length === 0) return;
  const me = await ownUser(db, data, { platform: platform.kind, host: platform.host });
  if (!me) return;
  const byName = new Map(repos.map((r) => [r.fullName.toLowerCase(), r]));
  const team = new Set(asks.map((a) => pullKey(a.repo, a.number)));
  const enrolled = listing.pulls.flatMap((p) => {
    const repo = byName.get(p.repo.toLowerCase());
    return repo ? [{ p, repo }] : [];
  });
  const held = new Map(
    (
      await data.pullIndex.byNumbers(
        enrolled.map(({ p, repo }) => ({ reviewRepoId: repo.id, number: p.number })),
      )
    ).map((r) => [`${r.reviewRepoId}#${r.number}`, r]),
  );
  for (const { p, repo } of enrolled) {
    const through = team.has(pullKey(p.repo, p.number));
    const facts = liveFacts(p, held.get(`${repo.id}#${p.number}`), me.id, through);
    if (!facts || !mergeFacts(held.get(`${repo.id}#${p.number}`), facts)) continue;
    await applyFacts(data, repo.id, p.number, (read) => liveFacts(p, read, me.id, through));
  }
  // A merge queue moves without a pull request webhook: the index never holds it.
  if (listing.more || listing.pulls.some((p) => p.queued)) return;
  const live = rolesOf(listing.pulls);
  const before = await indexView(data, platform, me.id, asks, now);
  for (const { row, repo } of before?.rows ?? []) {
    if (live.has(pullKey(repo.fullName, row.number)) || row.changedAt > readAt) continue;
    await applyFacts(data, repo.id, row.number, (read) =>
      read && read.changedAt <= readAt
        ? {
            number: read.number,
            changedAt: read.changedAt,
            reviewerIds: withMe(read.reviewerIds, me.id, false),
            assigneeIds: withMe(read.assigneeIds, me.id, false),
          }
        : null,
    );
  }
  const view = await indexView(data, platform, me.id, asks, now);
  if (!view) return;
  const indexed = rolesOf(view.pulls);
  if (indexed.size !== live.size) return;
  for (const [key, roles] of live) if (indexed.get(key) !== roles) return;
  await data.pullIndex.verified(platform.kind, platform.host, readAt);
}
