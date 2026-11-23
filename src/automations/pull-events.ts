import type { Context } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import { defer } from "../defer.js";
import { githubCiFailure, gitlabCiFailure } from "../notify/ci-hooks.js";
import type { AutomationPullFacts, AutomationTrigger } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { automate } from "./run.js";

// A pull request's events after it is queued, as an enrolled repository's
// webhooks say, as automation events: out of draft, approved by someone
// other than its author or a bot, its CI failed on its head (as
// ../notify/ci-hooks.ts reads it), a label added, merged. Each event's key
// names the pull request and what makes the event one: its head, the
// platform's review or approver, the label, so a redelivery, or the
// platform saying it twice, runs a rule once (the run's unique (rule,
// event) index). What the delivery does not say of the pull request, its
// author and title, is read from what its earlier events stored.

type Repo = Row<"reviewRepos">;

export type PullEvent = {
  repo: Repo;
  trigger: AutomationTrigger;
  eventKey: string;
  fullName: string;
  number: number;
  facts: Omit<AutomationPullFacts, "repoId">;
};

const githubUser = z.object({ login: z.string(), type: z.string().optional() });
const isBot = (u: z.infer<typeof githubUser>) => u.type === "Bot" || u.login.endsWith("[bot]");

const githubPull = z.object({
  number: z.number().int().min(1).optional(),
  head: z.object({ sha: z.string() }),
  title: z.string().optional(),
  user: githubUser.optional(),
  base: z.object({ ref: z.string() }).optional(),
  labels: z.array(z.object({ name: z.string() })).optional(),
  merged: z.boolean().optional(),
});

const githubPullEvent = z.object({
  action: z.string(),
  number: z.number().int().min(1),
  label: z.object({ name: z.string() }).optional(),
  pull_request: githubPull,
  repository: z.object({ id: z.number(), full_name: z.string() }),
});

const githubReviewEvent = z.object({
  action: z.literal("submitted"),
  review: z.object({ id: z.number(), state: z.string(), user: githubUser.nullable() }),
  pull_request: githubPull.extend({ number: z.number().int().min(1) }),
  repository: z.object({ id: z.number(), full_name: z.string() }),
});

const githubRepository = z.object({
  repository: z.object({ id: z.number(), full_name: z.string() }),
});

const fold = (s: string) => s.toLowerCase();

function githubFacts(pull: z.infer<typeof githubPull>): PullEvent["facts"] {
  return {
    ...(pull.user ? { author: pull.user.login } : {}),
    ...(pull.base ? { baseBranch: pull.base.ref } : {}),
    ...(pull.title !== undefined ? { title: pull.title } : {}),
    ...(pull.labels ? { labels: pull.labels.map((l) => l.name) } : {}),
  };
}

/** A GitHub App webhook's delivery (src/webhooks.ts verified it) as the automation events it is. */
export async function githubPullEvents(
  db: Db,
  host: string,
  event: string,
  body: unknown,
  ownAppId: string | undefined,
): Promise<PullEvent[]> {
  const repoOf = (id: number) => reviewRepoFor(db, "github", host, String(id));
  if (event === "pull_request") {
    const parsed = githubPullEvent.safeParse(body);
    if (!parsed.success) return [];
    const { action, number, label, pull_request: pull, repository } = parsed.data;
    const trigger =
      action === "closed" && pull.merged === true
        ? "merged"
        : action === "ready_for_review"
          ? "ready_for_review"
          : action === "labeled" && label
            ? "labeled"
            : undefined;
    if (!trigger) return [];
    const repo = await repoOf(repository.id);
    if (!repo) return [];
    const key = (k: string) => `${k}:${repo.id}#${number}`;
    const facts = githubFacts(pull);
    const one = { repo, trigger, fullName: repository.full_name, number } as const;
    if (trigger === "merged") return [{ ...one, eventKey: key("merged"), facts }];
    if (trigger === "ready_for_review") {
      return [{ ...one, eventKey: `${key("ready")}@${pull.head.sha}`, facts }];
    }
    const name = label?.name ?? "";
    return [
      { ...one, eventKey: `${key("labeled")}:${fold(name)}`, facts: { ...facts, labels: [name] } },
    ];
  }
  if (event === "pull_request_review") {
    const parsed = githubReviewEvent.safeParse(body);
    if (!parsed.success) return [];
    const { review, pull_request: pull, repository } = parsed.data;
    if (review.state.toLowerCase() !== "approved" || !review.user || isBot(review.user)) return [];
    if (pull.user && review.user.login === pull.user.login) return [];
    const repo = await repoOf(repository.id);
    if (!repo) return [];
    return [
      {
        repo,
        trigger: "approved",
        eventKey: `approved:${repo.id}#${pull.number}:github:${review.id}`,
        fullName: repository.full_name,
        number: pull.number,
        facts: githubFacts(pull),
      },
    ];
  }
  const failure = githubCiFailure(event, body, ownAppId);
  const named = githubRepository.safeParse(body);
  if (!failure || !named.success) return [];
  const repo = await repoOf(named.data.repository.id);
  if (!repo) return [];
  return checksFailed(db, repo, named.data.repository.full_name, failure);
}

async function checksFailed(
  db: Db,
  repo: Repo,
  fullName: string,
  failure: { head: string; numbers: number[] },
): Promise<PullEvent[]> {
  const data = scoped(db, repo.accountId);
  const events: PullEvent[] = [];
  for (const number of failure.numbers) {
    events.push({
      repo,
      trigger: "checks_failed",
      eventKey: `checks_failed:${repo.id}#${number}@${failure.head}`,
      fullName,
      number,
      facts: await stored(data, repo, number),
    });
  }
  return events;
}

/** The author and title its earlier events stored. */
async function stored(data: Scoped, repo: Repo, number: number): Promise<PullEvent["facts"]> {
  const flow = await data.findOne("pullFlows", { reviewRepoId: repo.id, number });
  return {
    ...(flow?.author ? { author: flow.author } : {}),
    ...(flow ? { title: flow.title } : {}),
  };
}

const gitlabLabels = z.array(z.object({ title: z.string() }));

const gitlabMergeRequest = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.string().optional(),
    title: z.string().optional(),
    target_branch: z.string().optional(),
    author_id: z.number().optional(),
    last_commit: z.object({ id: z.string() }).optional(),
  }),
  user: z.object({ id: z.number(), username: z.string() }).optional(),
  labels: gitlabLabels.optional(),
  changes: z
    .object({
      labels: z
        .object({ previous: gitlabLabels.nullish(), current: gitlabLabels.nullish() })
        .optional(),
      draft: z
        .object({ previous: z.boolean().nullish(), current: z.boolean().nullish() })
        .optional(),
    })
    .optional(),
});

const APPROVALS = new Set(["approved", "approval"]);

/** A GitLab hook its repository's secret proved, as the automation events it is. */
export async function gitlabPullEvents(
  db: Db,
  repo: Repo,
  kind: string | undefined,
  body: unknown,
): Promise<PullEvent[]> {
  const failure = gitlabCiFailure(kind, body);
  if (failure) return checksFailed(db, repo, repo.fullName, failure);
  if (kind !== "Merge Request Hook") return [];
  const parsed = gitlabMergeRequest.safeParse(body);
  if (!parsed.success) return [];
  const { object_attributes: a, user, labels, changes } = parsed.data;
  const key = (k: string) => `${k}:${repo.id}#${a.iid}`;
  // The secret proves the project, not the path the body names: the bot writes where it is enrolled.
  const one = { repo, fullName: repo.fullName, number: a.iid };
  const events: Omit<PullEvent, "facts">[] = [];
  if (a.action === "merge") events.push({ ...one, trigger: "merged", eventKey: key("merged") });
  if (a.action && APPROVALS.has(a.action) && user && user.id !== a.author_id) {
    events.push({ ...one, trigger: "approved", eventKey: `${key("approved")}:gitlab:${user.id}` });
  }
  if (changes?.draft?.previous === true && changes.draft.current === false && a.last_commit) {
    events.push({
      ...one,
      trigger: "ready_for_review",
      eventKey: `${key("ready")}@${a.last_commit.id}`,
    });
  }
  const before = new Set((changes?.labels?.previous ?? []).map((l) => fold(l.title)));
  const added = (changes?.labels?.current ?? []).filter((l) => !before.has(fold(l.title)));
  if (events.length === 0 && added.length === 0) return [];
  const facts: PullEvent["facts"] = {
    // Who caused the event is the author only when the merge request opens.
    ...(a.action === "open" && user ? { author: user.username } : {}),
    ...(a.target_branch !== undefined ? { baseBranch: a.target_branch } : {}),
    ...(a.title !== undefined ? { title: a.title } : {}),
    ...(labels ? { labels: labels.map((l) => l.title) } : {}),
  };
  if (!facts.author) {
    const known = await stored(scoped(db, repo.accountId), repo, a.iid);
    if (known.author) facts.author = known.author;
  }
  return [
    ...events.map((e) => ({ ...e, facts })),
    ...added.map((l) => ({
      ...one,
      trigger: "labeled" as const,
      eventKey: `${key("labeled")}:${fold(l.title)}`,
      facts: { ...facts, labels: [l.title] },
    })),
  ];
}

/** Runs the account's rules on each event after the answer. */
export async function automatePullEvents(
  c: Context<AppEnv>,
  events: readonly PullEvent[],
): Promise<void> {
  for (const e of events) {
    const data = scoped(c.var.db, e.repo.accountId);
    const { run } = await automate(c, data, {
      trigger: e.trigger,
      eventKey: e.eventKey,
      repo: { ...e.repo, fullName: e.fullName },
      pull: { host: e.repo.host, fullName: e.fullName, number: e.number },
      facts: { repoId: e.repo.id, ...e.facts },
      acts: true,
      consoleUrl: new URL("/settings", c.req.url).toString(),
    });
    defer(c, run);
  }
}
