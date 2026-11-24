import { and, asc, desc, eq, or, type SQL } from "drizzle-orm";
import type { Db } from "./client.js";
import { containsText } from "./dialect.js";
import { findings, graphRepos, repositories, reviewRepos, reviews } from "./schema.js";

// The console's search over the account's rows, reached through scoped().
// Each query finds the account's rows through an index that leads with
// account_id (test/query-plans.test.ts), newest first where the index
// gives that order, and stops at `limit`. A match anywhere in a name or
// title cannot use an index, so it reads the account's rows only.

/** Words, or a pull request's number and, when the query named one, its repository. */
export type StoredSearch = { text: string } | { repo: string | null; number: number };

const asNumber = (text: string) => (/^\d{1,9}$/.test(text) ? Number(text) : null);

export function accountSearch(db: Db, accountId: string) {
  return {
    /** Reviews by repository (its pull request's or the name the account gave) and pull request number. */
    reviews(search: StoredSearch, limit: number) {
      const r = reviews;
      const n = repositories;
      const named = (text: string) =>
        or(containsText(db, r.prRepository, text), containsText(db, n.name, text));
      let match: SQL | undefined;
      if ("text" in search) {
        const number = asNumber(search.text);
        match =
          number === null ? named(search.text) : or(named(search.text), eq(r.prNumber, number));
      } else {
        match = and(eq(r.prNumber, search.number), search.repo ? named(search.repo) : undefined);
      }
      return db
        .select({
          id: r.id,
          prRepository: r.prRepository,
          prNumber: r.prNumber,
          verdict: r.verdict,
          findings: r.findings,
          createdAt: r.createdAt,
          name: n.name,
        })
        .from(r)
        .leftJoin(n, and(eq(n.accountId, accountId), eq(n.repoHash, r.repoHash)))
        .where(and(eq(r.accountId, accountId), match))
        .orderBy(desc(r.createdAt))
        .limit(limit);
    },

    /** Shared findings by title or file path, open ones first, newest first. */
    findings(text: string, limit: number) {
      const f = findings;
      // "open" sorts above every other status (FINDING_STATUSES): the index read backwards.
      return db
        .select({
          id: f.id,
          reviewId: f.reviewId,
          title: f.title,
          file: f.file,
          lineStart: f.lineStart,
          severity: f.severity,
          status: f.status,
        })
        .from(f)
        .where(
          and(
            eq(f.accountId, accountId),
            or(containsText(db, f.title, text), containsText(db, f.file, text)),
          ),
        )
        .orderBy(desc(f.status), desc(f.createdAt), desc(f.id))
        .limit(limit);
    },

    /** Enrolled and graph repositories by path. */
    async repositories(text: string, limit: number) {
      const pick = (t: typeof reviewRepos | typeof graphRepos) =>
        db
          .select({ platform: t.platform, host: t.host, fullName: t.fullName })
          .from(t)
          .where(and(eq(t.accountId, accountId), containsText(db, t.fullName, text)))
          .orderBy(asc(t.fullName))
          .limit(limit);
      const [enrolled, graphed] = await db.batch([pick(reviewRepos), pick(graphRepos)]);
      return { enrolled, graphed };
    },
  };
}
