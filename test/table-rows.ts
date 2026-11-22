import type * as schema from "../src/db/schema.js";
import { DAY } from "../src/time.js";

// One row per account-scoped table. A table added to the schema without a
// case here fails to compile (and the isolation test).
export const rows = {
  sessions: (id: string) => ({
    id,
    tokenHash: `hash-${id}`,
    kind: "cli" as const,
    expiresAt: new Date(Date.now() + DAY),
  }),
  providerKeys: (id: string) => ({
    id,
    provider: "openrouter",
    wrappedKey: "w",
    ciphertext: "c",
    last4: "abcd",
  }),
  reviews: (id: string) => ({ id, runId: `run-${id}`, repoHash: "r", source: "local" as const }),
  auditEvents: (id: string) => ({ id, kind: "key.used", detail: { model: "m" } }),
  gatewayCalls: (id: string) => ({
    id,
    provider: "openrouter",
    path: "/v1/chat/completions",
    status: 200,
  }),
  preferences: (_id: string) => ({ models: { standard: ["ocra-openrouter/m"] } }),
  preferenceVersions: (id: string) => ({ id, snapshot: { models: {} }, changed: ["models"] }),
  // The review it belongs to is made in beforeEach (the foreign key needs one).
  findings: (id: string) => ({
    id,
    reviewId: "review-of-a",
    fingerprint: `fp-${id}`,
    reviewer: "security",
    severity: "warning" as const,
    file: "a.ts",
    title: "t",
    body: "b",
  }),
  accountMemory: (id: string) => ({
    id,
    repoHash: "h",
    fingerprint: `fp-${id}`,
    reason: "accepted",
  }),
  budgets: (_id: string) => ({ dailyCalls: 100 }),
  platformLinks: (_id: string) => ({
    platform: "github" as const,
    host: "github.com",
    wrappedKey: "w",
    ciphertext: "c",
  }),
  pullViews: (id: string) => ({
    id,
    name: `view ${id}`,
    filters: { roles: ["author" as const] },
    position: 0,
  }),
  pullSeen: (id: string) => ({
    id,
    platform: "github" as const,
    repo: `octo/${id}`,
    number: 1,
    updatedAt: new Date(),
    seenAt: new Date(),
  }),
  pullFileViews: (id: string) => ({
    id,
    platform: "gitlab" as const,
    repo: `group/${id}`,
    number: 1,
    path: "app.rb",
    sha: "e".repeat(64),
    viewedAt: new Date(),
  }),
  graphRepos: (id: string) => ({
    id,
    platform: "github" as const,
    host: "github.com",
    platformRepoId: `gh-${id}`,
    fullName: `octo/${id}`,
    branch: "main",
  }),
  // The graph repository it belongs to is made in beforeEach (the foreign key needs one).
  graphBuilds: (id: string) => ({ id, graphRepoId: "graph-repo-of-a", commit: `c-${id}` }),
  reviewRepos: (id: string) => ({
    id,
    platform: "github" as const,
    host: "github.com",
    platformRepoId: `gh-${id}`,
    fullName: `octo/${id}`,
  }),
  // The enrolled repository it belongs to is made in beforeEach (the foreign key needs one).
  reviewJobs: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    number: 1,
    head: `h-${id}`,
  }),
  notifyChannels: (id: string) => ({
    id,
    kind: "slack" as const,
    name: `chat ${id}`,
    when: "every" as const,
    wrappedKey: "w",
    ciphertext: "c",
    last4: "abcd",
  }),
  notifySends: (id: string) => ({ id, channelId: "channel", eventKey: `review:${id}` }),
  notifyHeld: (id: string) => ({
    id,
    channelId: "channel",
    eventKey: `comment:${id}`,
    event: "pull_commented" as const,
    platform: "github" as const,
    repo: "octo/api",
    number: 1,
    line: "hubot commented on your pull request",
  }),
  // The enrolled repository it belongs to is made in beforeEach (the foreign key needs one).
  closedPulls: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    number: 1,
    title: `pull ${id}`,
    merged: true,
    closedAt: new Date(),
  }),
  // The enrolled repository it belongs to is made in beforeEach (the foreign key needs one).
  pullFlows: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    number: 1,
    title: `pull ${id}`,
    seenAt: new Date(),
  }),
  // The enrolled repository it belongs to is made in beforeEach (the foreign key needs one).
  reviewThreads: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    number: 1,
    threadKey: `thread-${id}`,
    starterId: "42",
    starterLogin: "mona",
    startedAt: new Date(),
    seenAt: new Date(),
  }),
  // The enrolled repository it belongs to is made in beforeEach (the foreign key needs one).
  pullReviews: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    number: 1,
    reviewKey: `github:${id}`,
    reviewer: "mona",
    approved: true,
    submittedAt: new Date(),
  }),
  // The enrolled repository it belongs to is made in beforeEach (the foreign key needs one).
  pullPaths: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    number: 1,
    head: "c".repeat(40),
    prefix: `src/${id}`,
    seenAt: new Date(),
  }),
  // The enrolled repository it belongs to is made in beforeEach (the foreign key needs one).
  reviewRequests: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    number: 1,
    reviewerId: `reviewer-${id}`,
    requestedAt: new Date(),
  }),
  // The enrolled repository it belongs to is made in beforeEach (the foreign key needs one).
  replyJobs: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    number: 1,
    commentId: `c-${id}`,
  }),
  // The enrolled repository it belongs to is made in beforeEach (the foreign key needs one).
  generateJobs: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    number: 1,
    head: `h-${id}`,
    kind: "tests" as const,
  }),
  // The review it belongs to is made in beforeEach (the foreign key needs one).
  reviewWalkthroughs: (id: string) => ({
    id,
    reviewId: "review-of-a",
    overview: "o",
    groups: [{ title: "g", files: ["a.ts"], note: "n" }],
  }),
  automationRules: (id: string) => ({
    id,
    name: `rule ${id}`,
    trigger: "reviewed" as const,
    conditions: { critical: true },
    actions: [{ kind: "skip_review" as const }],
    updatedAt: new Date(),
  }),
  automationRuns: (id: string) => ({
    id,
    ruleId: `rule-${id}`,
    ruleName: "rule",
    trigger: "reviewed" as const,
    pull: "octo/api#7",
    eventKey: `review:${id}`,
    actions: [],
  }),
  // The enrolled repository they belong to is made in beforeEach (the foreign key needs one).
  mergeChecks: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    kind: "size" as const,
    mode: "warn" as const,
    settings: { maxFiles: 10 },
  }),
  mergeCheckRuns: (id: string) => ({
    id,
    reviewRepoId: "review-repo-of-a",
    number: 1,
    head: `h-${id}`,
    conclusion: "success" as const,
    results: [],
    digest: "d",
  }),
  mergeIntents: (id: string) => ({
    id,
    platform: "github" as const,
    host: "github.com",
    fullName: `octo/${id}`,
    number: 1,
    method: "squash" as const,
    mode: "server" as const,
    head: "a".repeat(40),
    state: "armed" as const,
    armedBy: "octo",
  }),
  // The finding it belongs to is made in beforeEach (the foreign key needs one).
  findingIssues: (id: string) => ({
    id,
    findingId: "finding-of-a",
    reviewId: "review-of-a",
    number: 7,
    url: "https://github.com/octo/api/issues/7",
    claimedAt: new Date(),
  }),
  // The review it belongs to is made in beforeEach (the foreign key needs one).
  reviewChatMessages: (id: string) => ({
    id,
    reviewId: "review-of-a",
    role: "user" as const,
    text: `question ${id}`,
  }),
  repositories: (id: string) => ({ id, repoHash: `h-${id}`, name: `octo/${id}` }),
  liveRuns: (id: string) => ({
    id,
    runId: `run-${id}`,
    repoHash: "r",
    source: "local" as const,
    updatedAt: new Date(),
  }),
  // The run and the grantee they belong to are made in beforeEach.
  liveEvents: (_id: string) => ({
    liveRunId: "live-run-of-a",
    seq: 1,
    kind: "started",
    data: {},
    at: "2026-11-22T00:00:00.000Z",
  }),
  liveGrants: (id: string) => ({
    id,
    liveRunId: "live-run-of-a",
    granteeId: "acct-b",
    role: "watch" as const,
  }),
  liveComments: (id: string) => ({
    id,
    liveRunId: "live-run-of-a",
    authorLogin: "a",
    body: "b",
  }),
  // One row per account, kind and day; the id names the day.
  usageCounters: (id: string) => ({ kind: "uploads" as const, day: id, n: 1 }),
} satisfies { [N in keyof typeof schema.accountTables]: (id: string) => unknown };
