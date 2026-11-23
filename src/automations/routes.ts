import { VERDICTS } from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { newId, type Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import {
  ASSIGN_STRATEGIES,
  AUTOMATION_TRIGGERS,
  type AutomationMatchView,
  type AutomationRuleView,
  type AutomationRunView,
  type AutomationSkipView,
  BOT_ACTIONS,
  MAX_ASSIGN_COUNT,
  MAX_ASSIGN_LOGINS,
  MAX_AUTOMATION_PATHS,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { triggerConflict } from "./rules.js";
import { MAX_RULES, matchingRules } from "./run.js";

// The account's automation rules: added, replaced and removed by the web
// session, tried on a described pull request (a dry run, which acts on
// nothing), and their runs listed newest first.

export const automationsRoute = new Hono<AppEnv>().use(requireSession(["web"]));

const MAX_RUNS = 100;

const CONTROL = /\p{Cc}/u;
const name = z.string().trim().min(1).max(64);
// A GitHub login or GitLab username; an App's bot account ends in [bot].
const login = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][\w.-]{0,98}(?:\[bot\])?$/, "a login");
// GitLab takes labels as one comma-separated list.
const label = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .refine((l) => !l.includes(",") && !CONTROL.test(l), "a label");
const branch = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((b) => !/[\s~^:?*[\\]/.test(b) && !CONTROL.test(b), "a branch name");
const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).min(1).max(max);
// A path glob of `*`, `?` and `**` (./paths.ts); classes, braces and a
// leading `!` would mean something else in .gitignore, so they are refused.
const pathGlob = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (g) => !/[[\]{}\\]/.test(g) && !g.startsWith("!") && !CONTROL.test(g),
    "a glob of *, ? and **",
  );
const paths = z
  .strictObject({
    include: list(pathGlob, 20).optional(),
    exclude: list(pathGlob, 20).optional(),
    every: z.boolean().optional(),
  })
  .refine((p) => p.include !== undefined || p.exclude !== undefined, "an include or exclude glob");

/** Plain text: line breaks kept, every other control character dropped. */
const plainText = (s: string) =>
  [...s.replace(/\r\n?/g, "\n")]
    .filter((ch) => ch === "\n" || !CONTROL.test(ch))
    .join("")
    .trim();

const conditions = z.strictObject({
  repoIds: list(z.string().max(64), 10).optional(),
  authors: list(login, 20).optional(),
  baseBranches: list(branch, 10).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  labels: list(label, 10).optional(),
  critical: z.boolean().optional(),
  verdicts: list(z.enum(VERDICTS), VERDICTS.length).optional(),
  paths: paths.optional(),
});

const action = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("add_labels"), labels: list(label, 10) }),
  z.strictObject({ kind: z.literal("request_reviewers"), reviewers: list(login, 10) }),
  z.strictObject({
    kind: z.literal("comment"),
    body: z.string().max(2000).transform(plainText).pipe(z.string().min(1)),
  }),
  z.strictObject({ kind: z.literal("notify"), channelId: z.string().max(64) }),
  z.strictObject({ kind: z.literal("skip_review") }),
  z
    .strictObject({
      kind: z.literal("assign_reviewers"),
      strategy: z.enum(ASSIGN_STRATEGIES),
      count: z.number().int().min(1).max(MAX_ASSIGN_COUNT),
      logins: list(login, MAX_ASSIGN_LOGINS).optional(),
      codeOwnersFirst: z.boolean().optional(),
    })
    .refine((a) => (a.strategy === "suggested") === (a.logins === undefined), {
      path: ["logins"],
      message: "logins for round_robin and least_loaded, none for suggested",
    }),
]);

const ruleBody = z.object({
  name,
  enabled: z.boolean().default(true),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  conditions,
  actions: list(action, 5),
});

const dryRunBody = z.object({
  trigger: z.enum(AUTOMATION_TRIGGERS),
  pull: z.strictObject({
    repoId: z.string().max(64).optional(),
    author: z.string().max(100).optional(),
    baseBranch: z.string().max(255).optional(),
    title: z.string().max(400).optional(),
    labels: z.array(z.string().max(50)).max(50).optional(),
    critical: z.boolean().optional(),
    verdict: z.enum(VERDICTS).optional(),
    paths: z.array(z.string().max(1024)).max(MAX_AUTOMATION_PATHS).optional(),
  }),
});

type RuleBody = z.output<typeof ruleBody>;

const ruleView = (r: Row<"automationRules">, hasBot: boolean) =>
  ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    trigger: r.trigger,
    conditions: r.conditions,
    actions: r.actions,
    runsHere: hasBot || !r.actions.some((a) => BOT_ACTIONS.includes(a.kind)),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }) satisfies AutomationRuleView;

const runView = (r: Row<"automationRuns">) =>
  ({
    id: r.id,
    ruleId: r.ruleId,
    ruleName: r.ruleName,
    trigger: r.trigger,
    pull: r.pull,
    outcome: r.outcome,
    reason: r.reason,
    actions: r.actions,
    attempts: r.attempts,
    retryAt: r.retryAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }) satisfies AutomationRunView;

const issue = (path: (string | number)[], message: string) => ({ issues: [{ path, message }] });

/** Why the rule cannot be saved, as invalid_body's issue; undefined when it can. */
async function refusal(data: AppEnv["Variables"]["data"], body: RuleBody) {
  const conflict = triggerConflict(body.trigger, body.conditions, body.actions);
  if (conflict) return issue(conflict, `not for a rule on ${body.trigger}`);
  for (const [i, id] of (body.conditions.repoIds ?? []).entries()) {
    if (!(await data.get("reviewRepos", id))) {
      return issue(["conditions", "repoIds", i], "not a repository this account enrolled");
    }
  }
  const assigns = body.actions.flatMap((a, i) => (a.kind === "assign_reviewers" ? [i] : []));
  if (assigns.length > 1) {
    return issue(["actions", assigns[1] ?? 0], "one assign_reviewers action a rule");
  }
  for (const [i, a] of body.actions.entries()) {
    if (a.kind === "notify" && !(await data.get("notifyChannels", a.channelId))) {
      return issue(["actions", i, "channelId"], "not a channel of this account");
    }
  }
  return undefined;
}

automationsRoute.get("/rules", async (c) => {
  const rows = await c.var.data.find("automationRules", {}, MAX_RULES);
  return c.json({ rules: rows.map((r) => ruleView(r, c.var.bots !== undefined)) });
});

automationsRoute.post("/rules", perMinute("settings"), jsonBody(ruleBody), async (c) => {
  const body = c.req.valid("json");
  const refused = await refusal(c.var.data, body);
  if (refused) return apiError(c, "invalid_body", refused);
  const id = newId();
  if (!(await c.var.data.automations.add({ id, ...body }, MAX_RULES))) {
    return apiError(c, "invalid_body", issue(["name"], `the account has ${MAX_RULES} rules`));
  }
  const stored = await c.var.data.get("automationRules", id);
  if (!stored) return apiError(c, "not_found");
  await audit(c.var.data, "automation.added", { rule: id, trigger: stored.trigger });
  return c.json({ rule: ruleView(stored, c.var.bots !== undefined) });
});

automationsRoute.put("/rules/:id", perMinute("settings"), jsonBody(ruleBody), async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json");
  const refused = await refusal(c.var.data, body);
  if (refused) return apiError(c, "invalid_body", refused);
  const changed = await c.var.data.update("automationRules", id, {
    ...body,
    updatedAt: new Date(),
  });
  const stored = changed && (await c.var.data.get("automationRules", id));
  if (!stored) return apiError(c, "not_found");
  await audit(c.var.data, "automation.changed", {
    rule: id,
    trigger: stored.trigger,
    enabled: stored.enabled,
  });
  return c.json({ rule: ruleView(stored, c.var.bots !== undefined) });
});

automationsRoute.delete("/rules/:id", async (c) => {
  const id = c.req.param("id");
  const removed = await c.var.data.remove("automationRules", id);
  if (removed) await audit(c.var.data, "automation.removed", { rule: id });
  return c.json({ removed });
});

automationsRoute.get("/runs", async (c) => {
  const rows = await c.var.data.listNewest("automationRuns", MAX_RUNS);
  return c.json({ runs: rows.map(runView) });
});

/**
 * The enabled rules that would run on the pull request described, and those
 * on paths it listed none for; nothing is done.
 */
automationsRoute.post("/dry-run", perMinute("settings"), jsonBody(dryRunBody), async (c) => {
  const { trigger, pull } = c.req.valid("json");
  const listed = pull.paths ? { paths: pull.paths, truncated: false } : null;
  const { rules, skipped } = await matchingRules(c.var.data, trigger, pull, async () => listed);
  return c.json({
    skipped: skipped.map(
      ({ rule, reason }) =>
        ({ ruleId: rule.id, name: rule.name, reason }) satisfies AutomationSkipView,
    ),
    matches: rules.map(
      (r) =>
        ({
          ruleId: r.id,
          name: r.name,
          actions: r.actions.map((a) => a.kind),
        }) satisfies AutomationMatchView,
    ),
  });
});
