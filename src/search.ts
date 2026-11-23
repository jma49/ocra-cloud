import { Hono } from "hono";
import type { StoredSearch } from "./db/search.js";
import { accessToken } from "./platforms/links.js";
import type { CodePlatform } from "./platforms/platform.js";
import { type ListedPull, MAX_SEARCHED, type PullSearch } from "./platforms/pulls.js";
import { platformsOf } from "./platforms/registry.js";
import { repoName } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { repoOfIdentity } from "./review-pull.js";
import { requireSession } from "./session.js";
import {
  MAX_SEARCH_LIMIT,
  matchDestinations,
  normaliseSearchQuery,
  pullPath,
  pullReferenceOf,
  SEARCH_LIMIT,
  type SearchFindingResult,
  type SearchPlatformPulls,
  type SearchPullResult,
  type SearchRepositoryResult,
  type SearchResultsView,
  type SearchReviewResult,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// The console's search (⌘K), for the web session: pull requests read live
// from each connected platform as the user, and the account's own reviews,
// shared findings and repositories. A platform that fails or is slow is
// marked and the rest still answer. Learnings are not searched: they live
// as files in each repository, one platform call apiece.

/** A platform's answer after this long is dropped and the platform marked. */
const PLATFORM_WAIT_MS = 5_000;

const within = <T>(work: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work.catch(() => null), late]).finally(() => clearTimeout(timer));
};

function limitOf(raw: string | undefined): number {
  const n = Math.trunc(Number(raw ?? SEARCH_LIMIT));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_SEARCH_LIMIT) : SEARCH_LIMIT;
}

const pullResult = (platform: CodePlatform, p: ListedPull): SearchPullResult => ({
  platform: platform.kind,
  host: platform.host,
  id: p.id,
  number: p.number,
  title: p.title,
  url: p.url,
  repo: p.repo,
  author: p.author,
  authorAvatar: p.authorAvatar,
  draft: p.draft,
  state: p.state,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  mergedAt: p.mergedAt,
  checks: p.checks,
  review: p.review,
  additions: p.additions,
  deletions: p.deletions,
  to: pullPath(platform.kind, p.repo, p.number),
});

export function searchRoute(features: { autoReview: boolean; codeGraphs: boolean }) {
  const route = new Hono<AppEnv>();

  route.get("/", requireSession(["web"]), perMinute("platform"), async (c) => {
    const query = normaliseSearchQuery(c.req.query("q") ?? "");
    const limit = limitOf(c.req.query("limit"));
    const destinations = matchDestinations(query, features, limit);
    const empty: SearchResultsView = {
      query,
      jump: null,
      pulls: [],
      reviews: [],
      findings: c.var.session.account.shareFindings ? [] : null,
      repositories: [],
      destinations,
    };
    if (!query) return c.json(empty);

    const reference = pullReferenceOf(query);
    const named = reference?.repo ? repoName.safeParse(reference.repo).success : true;
    const search: PullSearch & StoredSearch = reference && named ? reference : { text: query };
    const data = c.var.data;
    const sharing = c.var.session.account.shareFindings;

    const pulls = Promise.all(
      platformsOf(c.env, c.req.url).map(async (platform): Promise<SearchPlatformPulls> => {
        const head = { platform: platform.kind, host: platform.host };
        const token = await accessToken(data, c.env, platform);
        if (!token) return { ...head, linked: false, error: null, results: [] };
        const found = await within(
          platform.searchPulls(token, search, Math.min(limit, MAX_SEARCHED)),
          PLATFORM_WAIT_MS,
        );
        if (!found) return { ...head, linked: true, error: "unavailable", results: [] };
        return {
          ...head,
          linked: true,
          error: null,
          results: found.slice(0, limit).map((p) => pullResult(platform, p)),
        };
      }),
    );
    const [platforms, reviewRows, findingRows, repoRows] = await Promise.all([
      pulls,
      data.search.reviews(search, limit),
      sharing && "text" in search ? data.search.findings(search.text, limit) : null,
      "text" in search || search.repo
        ? data.search.repositories("text" in search ? search.text : (search.repo ?? ""), limit)
        : null,
    ]);

    const reviewResults = reviewRows.map(
      (r): SearchReviewResult => ({
        id: r.id,
        repo: r.name ?? (r.prRepository ? (repoOfIdentity(r.prRepository)?.repo ?? null) : null),
        prNumber: r.prNumber,
        verdict: r.verdict,
        findings: r.findings,
        createdAt: r.createdAt.toISOString(),
        to: `/reviews/${encodeURIComponent(r.id)}`,
      }),
    );
    const findingResults =
      findingRows?.map(
        (f): SearchFindingResult => ({
          id: f.id,
          reviewId: f.reviewId,
          title: f.title,
          file: f.file,
          line: f.lineStart,
          severity: f.severity,
          status: f.status,
          to: `/reviews/${encodeURIComponent(f.reviewId)}`,
        }),
      ) ?? (sharing ? [] : null);

    const repos = new Map<string, SearchRepositoryResult>();
    const addRepo = (
      r: { platform: SearchRepositoryResult["platform"]; host: string; fullName: string },
      kind: "autoReview" | "codeGraph",
    ) => {
      const key = `${r.platform}|${r.host}|${r.fullName}`;
      const seen = repos.get(key) ?? {
        ...r,
        autoReview: false,
        codeGraph: false,
        to: kind === "autoReview" ? "/auto-review" : "/code-graphs",
      };
      seen[kind] = true;
      repos.set(key, seen);
    };
    for (const r of repoRows?.enrolled ?? []) addRepo(r, "autoReview");
    for (const r of repoRows?.graphed ?? []) addRepo(r, "codeGraph");

    const live = platforms.flatMap((p) => p.results);
    const jump = reference && named && live.length === 1 ? (live[0] ?? null) : null;

    return c.json({
      ...empty,
      jump,
      pulls: platforms,
      reviews: reviewResults,
      findings: findingResults,
      repositories: [...repos.values()]
        .sort((a, b) => a.fullName.localeCompare(b.fullName))
        .slice(0, limit),
    } satisfies SearchResultsView);
  });

  return route;
}
