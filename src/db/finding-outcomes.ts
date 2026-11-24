import { and, eq, inArray, isNull, ne, type SQL, sql } from "drizzle-orm";
import type { FixedVia } from "../shared/index.js";
import { changedRows, type Db } from "./client.js";
import { jsonTexts } from "./dialect.js";
import { findings, reviews } from "./schema.js";

// What became of a finding on its platform: its fix or its comment's
// suggestion committed from the console, its comment's thread resolved or
// reopened (from the console or on the platform), a later review of the
// pull request seeing it fixed, and the pull request merging with it still
// open. Each write compares and sets in one statement, so a finding is
// marked fixed, and its source recorded, once, and a decision the account
// made is never overwritten by a thread or a merge. Reached only through
// scoped().

const f = findings;

const fixed = (via: FixedVia) => ({
  status: "fixed" as const,
  reason: null,
  note: null,
  decidedAt: new Date(),
  fixedVia: via,
});

/** A pull request by its repository's identity (lower case) and number. */
export type OnPull = { identity: string; number: number };

/** The account's findings in its reviews of this pull request. */
function ofPull(accountId: string, pull: OnPull): SQL | undefined {
  const r = reviews;
  return and(
    eq(f.accountId, accountId),
    sql`${f.reviewId} IN (SELECT ${r.id} FROM ${r} WHERE ${r.accountId} = ${accountId}
      AND ${r.prNumber} = ${pull.number} AND lower(${r.prRepository}) = ${pull.identity})`,
  );
}

/** The account's findings, in its reviews of this pull request, with these fingerprints. */
function onPull(db: Db, accountId: string, pull: FindingsOnPull): SQL | undefined {
  return and(
    ofPull(accountId, pull),
    sql`${f.fingerprint} IN (${jsonTexts(db, JSON.stringify(pull.fingerprints))})`,
  );
}

/** A pull request and ocra's findings on it, by fingerprint. */
export type FindingsOnPull = OnPull & { fingerprints: readonly string[] };

/** Marks these of the account's findings fixed via `via`, of those not fixed yet; returns how many. */
async function markFixed(
  db: Db,
  accountId: string,
  ids: readonly string[],
  via: FixedVia,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db
    .update(f)
    .set(fixed(via))
    .where(and(eq(f.accountId, accountId), inArray(f.id, [...ids]), ne(f.status, "fixed")));
  return changedRows(result);
}

/** Marks the pull request's findings with these fingerprints fixed via `via`, of those not fixed yet. */
async function markFixedOnPull(
  db: Db,
  accountId: string,
  pull: FindingsOnPull,
  via: FixedVia,
): Promise<number> {
  if (pull.fingerprints.length === 0) return 0;
  const result = await db
    .update(f)
    .set(fixed(via))
    .where(and(onPull(db, accountId, pull), ne(f.status, "fixed")));
  return changedRows(result);
}

/**
 * Marks the pull request's findings with these fingerprints fixed by a
 * re-review: an open one, or one whose thread a person resolved or whose
 * pull request merged (a fix seen is more than either says). One already
 * fixed, or dismissed by the account, keeps its fate.
 */
async function markFixedOnRereview(db: Db, accountId: string, pull: FindingsOnPull) {
  if (pull.fingerprints.length === 0) return 0;
  const result = await db
    .update(f)
    .set(fixed("rereview"))
    .where(
      and(
        onPull(db, accountId, pull),
        inArray(f.status, ["open", "addressed", "merged"]),
        isNull(f.fixedVia),
      ),
    );
  return changedRows(result);
}

/**
 * Records that a person resolved (or reopened) the threads of the pull
 * request's findings, at `at`: an open finding becomes addressed, and an
 * addressed one open again; a decision the account made stays.
 */
async function markThreadResolved(
  db: Db,
  accountId: string,
  pull: FindingsOnPull,
  resolved: boolean,
  at = new Date(),
): Promise<number> {
  if (pull.fingerprints.length === 0) return 0;
  const ms = at.getTime();
  const result = await db
    .update(f)
    .set(
      resolved
        ? {
            threadResolvedAt: sql`coalesce(${f.threadResolvedAt}, ${ms})`,
            status: sql`CASE WHEN ${f.status} = 'open' THEN 'addressed' ELSE ${f.status} END`,
            decidedAt: sql`CASE WHEN ${f.status} = 'open' THEN ${ms} ELSE ${f.decidedAt} END`,
          }
        : {
            threadResolvedAt: null,
            status: sql`CASE WHEN ${f.status} = 'addressed' THEN 'open' ELSE ${f.status} END`,
            decidedAt: sql`CASE WHEN ${f.status} = 'addressed' THEN NULL ELSE ${f.decidedAt} END`,
          },
    )
    .where(onPull(db, accountId, pull));
  return changedRows(result);
}

/**
 * The pull request merged at `at`: its findings still open become merged
 * (unaddressed). One fixed, dismissed or addressed keeps its fate, and a fix
 * a later review sees still makes a merged one fixed.
 */
async function markMerged(db: Db, accountId: string, pull: OnPull, at: Date): Promise<number> {
  const result = await db
    .update(f)
    .set({ status: "merged", decidedAt: at })
    .where(and(ofPull(accountId, pull), eq(f.status, "open")));
  return changedRows(result);
}

export function accountFindingOutcomes(db: Db, accountId: string) {
  return {
    markFixed: (ids: readonly string[], via: FixedVia) => markFixed(db, accountId, ids, via),
    markFixedOnPull: (pull: FindingsOnPull, via: FixedVia) =>
      markFixedOnPull(db, accountId, pull, via),
    markFixedOnRereview: (pull: FindingsOnPull) => markFixedOnRereview(db, accountId, pull),
    markThreadResolved: (pull: FindingsOnPull, resolved: boolean, at?: Date) =>
      markThreadResolved(db, accountId, pull, resolved, at),
    markMerged: (pull: OnPull, at: Date) => markMerged(db, accountId, pull, at),
  };
}
