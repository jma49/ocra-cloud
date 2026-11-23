import type { Owner } from "../codeowners.js";
import type { Row, Scoped } from "../db/scoped.js";
import { isBotLogin } from "../platforms/reviewers.js";
import { suggestReviewers } from "../reviewer-suggest.js";
import type {
  AssignReviewers,
  AutomationActionOutcome,
  SuggestedReviewer,
} from "../shared/index.js";
import type { Bot } from "./run.js";

// An assign_reviewers action: the rule claims the pull request once (a
// webhook delivered again, a reopen or a later ready_for_review asks no
// one more), reads it as the bot, chooses by its strategy and asks them.
// A round robin reserves its logins by moving the rule's cursor with a
// compare-and-set before asking, so two pull requests opened at once get
// different ones. When the pull request could not be read the claim is
// given up, for the next event to try; a request the platform did not
// answer is tried again with the same logins (./retry.ts).

/** Attempts at moving a round robin's cursor that another run moved first. */
const CURSOR_TRIES = 5;

const key = (login: string) => login.toLowerCase();

export type PickInput = {
  action: AssignReviewers;
  author: string | null;
  requested: readonly string[];
  /** Users CODEOWNERS gives changed files to. */
  owners: readonly Owner[][];
  /** suggested: best first. */
  suggestions: readonly SuggestedReviewer[];
  /** least_loaded: open review requests of each configured login; null for one not read. */
  load: readonly (number | null)[];
  /** round_robin: the rule's cursor. */
  cursor: number;
};

/** Who to ask, and by how many places the round robin moves past them. */
export function pickReviewers(input: PickInput): { logins: string[]; advance: number } {
  const { action } = input;
  const want = action.count - input.requested.length;
  if (want <= 0) return { logins: [], advance: 0 };
  const author = input.author ? key(input.author) : null;
  const asked = new Set(input.requested.map(key));
  const owners = new Set(
    input.owners.flatMap((file) => file.filter((o) => o.kind === "user").map((o) => key(o.name))),
  );
  // Each candidate with its place in turn order, for the cursor.
  let order: { login: string; place: number }[];
  if (action.strategy === "suggested") {
    order = input.suggestions.map((s, place) => ({ login: s.login, place }));
  } else {
    const logins = action.logins ?? [];
    const start = logins.length > 0 ? input.cursor % logins.length : 0;
    order = logins.map((_, i) => {
      const place = (start + i) % logins.length;
      return { login: logins[place] ?? "", place: i };
    });
    if (action.strategy === "least_loaded") {
      const loadOf = (login: string) => {
        const n = input.load[logins.indexOf(login)];
        return n ?? Number.POSITIVE_INFINITY;
      };
      order = logins
        .map((login, place) => ({ login, place }))
        .sort((a, b) => loadOf(a.login) - loadOf(b.login) || a.place - b.place);
    }
  }
  const seen = new Set<string>();
  const eligible = order.filter(({ login }) => {
    const k = key(login);
    if (!login || k === author || asked.has(k) || isBotLogin(login) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const ranked = action.codeOwnersFirst
    ? [
        ...eligible.filter((c) => owners.has(key(c.login))),
        ...eligible.filter((c) => !owners.has(key(c.login))),
      ]
    : eligible;
  const chosen = ranked.slice(0, want);
  const advance =
    action.strategy === "round_robin" && chosen.length > 0
      ? Math.max(...chosen.map((c) => c.place)) + 1
      : 0;
  return { logins: chosen.map((c) => c.login), advance };
}

export type Assigned = {
  outcome: AutomationActionOutcome;
  /** Who was asked or is to be asked again; empty when no one. */
  logins: string[];
};

/** Claims, chooses and asks; the bot must exist (the caller checked the server has one). */
export async function assignReviewers(
  data: Scoped,
  bot: Bot,
  rule: Row<"automationRules">,
  repo: Row<"reviewRepos">,
  number: number,
  action: AssignReviewers,
): Promise<Assigned> {
  const writer = await bot();
  if (!writer) return { outcome: "refused", logins: [] };
  const claim = await data.automations.claimAssignment(rule.id, repo.id, number);
  if (!claim) return { outcome: "already_assigned", logins: [] };
  const { platform, credential } = writer;
  const token = credential.token;
  const found = await suggestReviewers(data, platform, token, repo.fullName, number, repo);
  if (typeof found === "string") {
    await data.automations.settleAssignment(claim, null);
    return { outcome: "unreached", logins: [] };
  }
  if (found.requested.length >= action.count) {
    await data.automations.settleAssignment(claim, []);
    return { outcome: "enough_reviewers", logins: [] };
  }
  const load =
    action.strategy === "least_loaded"
      ? await platform.reviewers.load(token, action.logins ?? [])
      : [];
  const base = { action, ...found, owners: found.perFile, load };
  const picked =
    action.strategy === "round_robin"
      ? await takeTurn(data, rule, (cursor) => pickReviewers({ ...base, cursor }))
      : pickReviewers({ ...base, cursor: 0 });
  if (!picked) {
    await data.automations.settleAssignment(claim, null);
    return { outcome: "unreached", logins: [] };
  }
  if (picked.logins.length === 0) {
    await data.automations.settleAssignment(claim, []);
    return { outcome: "no_candidates", logins: [] };
  }
  await data.automations.settleAssignment(claim, picked.logins);
  const sent = await platform.actions.requestReviewers(token, repo.fullName, number, picked.logins);
  if (sent === null) return { outcome: "unreached", logins: picked.logins };
  return { outcome: sent === "done" ? "done" : "refused", logins: picked.logins };
}

/** The round robin's pick, its turn reserved by moving the cursor; undefined when others kept moving it first. */
async function takeTurn(
  data: Scoped,
  rule: Row<"automationRules">,
  pick: (cursor: number) => ReturnType<typeof pickReviewers>,
) {
  let cursor = rule.assignCursor;
  for (let tries = 0; tries < CURSOR_TRIES; tries++) {
    const picked = pick(cursor);
    if (picked.advance === 0) return picked;
    if (await data.automations.moveCursor(rule.id, cursor, cursor + picked.advance)) return picked;
    const now = await data.get("automationRules", rule.id);
    if (!now) return undefined;
    cursor = now.assignCursor;
  }
  return undefined;
}
