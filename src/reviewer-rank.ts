import type { Owner } from "./codeowners.js";
import { isBotLogin } from "./platforms/reviewers.js";
import type { ReviewedPaths, ReviewerReason, SuggestedReviewer } from "./shared/index.js";

// How suggested reviewers are ranked: owning changed files counts most, then
// reviews of pull requests changing the same directories, then recent
// reviews of the repository, each capped so one large pull request or one
// busy reviewer does not drown the rest; open review requests take away.
// Of the directories, the one they reviewed most in counts and is named.

const OWNER_POINTS = 10;
const CAP = 10;
const PATH_POINTS = 2;
const LOAD_CAP = 5;

type RankInput = {
  author: string | null;
  requested: readonly string[];
  /** The owners of each changed file. */
  owners: readonly Owner[][];
  history: readonly { login: string; reviews: number }[];
  /** Per reviewer and changed directory, the pull requests changing it they reviewed. */
  paths: readonly ({ login: string } & ReviewedPaths)[];
};

type Ranked = Omit<SuggestedReviewer, "load">;

const key = (login: string) => login.toLowerCase();

export function rankReviewers(input: RankInput): Ranked[] {
  const author = input.author ? key(input.author) : null;
  const requested = new Set(input.requested.map(key));
  const byLogin = new Map<string, Ranked>();
  const entry = (login: string) => {
    const k = key(login);
    if (k === author || isBotLogin(login)) return undefined;
    let found = byLogin.get(k);
    if (!found) {
      found = {
        login,
        reasons: [],
        score: 0,
        ownedFiles: 0,
        recentReviews: 0,
        reviewedPaths: null,
        alreadyRequested: requested.has(k),
      };
      byLogin.set(k, found);
    }
    return found;
  };
  const reason = (r: Ranked, why: ReviewerReason) => {
    if (!r.reasons.includes(why)) r.reasons.push(why);
  };
  for (const fileOwners of input.owners) {
    for (const o of fileOwners) {
      if (o.kind !== "user") continue;
      const r = entry(o.name);
      if (!r) continue;
      r.ownedFiles++;
      reason(r, "codeowner");
    }
  }
  for (const p of input.paths) {
    const r = entry(p.login);
    if (!r || p.pulls <= 0) continue;
    if (!r.reviewedPaths || morePaths(p, r.reviewedPaths)) {
      r.reviewedPaths = { prefix: p.prefix, pulls: p.pulls };
    }
    reason(r, "reviewed_these_paths");
  }
  for (const h of input.history) {
    const r = entry(h.login);
    if (!r || h.reviews <= 0) continue;
    r.recentReviews += h.reviews;
    reason(r, "recent_reviewer");
  }
  for (const r of byLogin.values()) {
    r.score =
      (r.ownedFiles > 0 ? OWNER_POINTS + Math.min(r.ownedFiles, CAP) : 0) +
      Math.min((r.reviewedPaths?.pulls ?? 0) * PATH_POINTS, CAP) +
      Math.min(r.recentReviews, CAP);
  }
  return [...byLogin.values()].sort(byScore);
}

/** More pull requests first, then the deeper directory, then by name. */
function morePaths(a: ReviewedPaths, b: ReviewedPaths): boolean {
  if (a.pulls !== b.pulls) return a.pulls > b.pulls;
  const depth = a.prefix.split("/").length - b.prefix.split("/").length;
  return depth !== 0 ? depth > 0 : a.prefix < b.prefix;
}

function byScore(a: { score: number; login: string }, b: { score: number; login: string }) {
  return b.score - a.score || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0);
}

/** The ranked ones with their open review requests, which lower the score, best first. */
export function withLoad(ranked: Ranked[], load: readonly (number | null)[]): SuggestedReviewer[] {
  return ranked
    .map((r, i) => {
      const open = load[i] ?? null;
      return { ...r, load: open, score: Math.max(0, r.score - Math.min(open ?? 0, LOAD_CAP)) };
    })
    .sort(byScore);
}
