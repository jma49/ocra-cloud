import { and, eq, inArray, isNull, ne, type SQL, sql } from "drizzle-orm";
import type { FixedVia } from "../shared/index.js";
import { changedRows, type Db } from "./client.js";
import { jsonTexts } from "./dialect.js";
import { findings, reviews } from "./schema.js";

// What the console did to a finding through the platform: committed its fix
// or its comment's suggestion, or resolved its comment's thread; and what a
// later review of the pull request saw fixed. Each write compares and sets
// in one statement, so a finding is marked fixed, and its source recorded,
// once. Reached only through scoped().

const f = findings;

const fixed = (via: FixedVia) => ({
  status: "fixed" as const,
  reason: null,
  note: null,
  decidedAt: new Date(),
  fixedVia: via,
});

/** The account's findings, in its reviews of this pull request, with these fingerprints. */
function onPull(db: Db, accountId: string, pull: FindingsOnPull): SQL | undefined {
  const r = reviews;
  return and(
    eq(f.accountId, accountId),
    sql`${f.fingerprint} IN (${jsonTexts(db, JSON.stringify(pull.fingerprints))})`,
    sql`${f.reviewId} IN (SELECT ${r.id} FROM ${r} WHERE ${r.accountId} = ${accountId}
      AND ${r.prNumber} = ${pull.number} AND lower(${r.prRepository}) = ${pull.identity})`,
  );
}

/** A pull request by its repository's identity (lower case) and number, and ocra's findings on it. */
export type FindingsOnPull = { identity: string; number: number; fingerprints: readonly string[] };

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
 * Marks the pull request's open findings with these fingerprints fixed by a
 * re-review; one already fixed, or dismissed by the account, keeps its fate.
 */
async function markFixedOnRereview(db: Db, accountId: string, pull: FindingsOnPull) {
  if (pull.fingerprints.length === 0) return 0;
  const result = await db
    .update(f)
    .set(fixed("rereview"))
    .where(and(onPull(db, accountId, pull), eq(f.status, "open"), isNull(f.fixedVia)));
  return changedRows(result);
}

/** Records that the user resolved (or reopened) the threads of the pull request's findings. */
async function markThreadResolved(
  db: Db,
  accountId: string,
  pull: FindingsOnPull,
  resolved: boolean,
): Promise<number> {
  if (pull.fingerprints.length === 0) return 0;
  const result = await db
    .update(f)
    .set({
      threadResolvedAt: resolved ? sql`coalesce(${f.threadResolvedAt}, ${Date.now()})` : null,
    })
    .where(onPull(db, accountId, pull));
  return changedRows(result);
}

export function accountFindingOutcomes(db: Db, accountId: string) {
  return {
    markFixed: (ids: readonly string[], via: FixedVia) => markFixed(db, accountId, ids, via),
    markFixedOnPull: (pull: FindingsOnPull, via: FixedVia) =>
      markFixedOnPull(db, accountId, pull, via),
    markFixedOnRereview: (pull: FindingsOnPull) => markFixedOnRereview(db, accountId, pull),
    markThreadResolved: (pull: FindingsOnPull, resolved: boolean) =>
      markThreadResolved(db, accountId, pull, resolved),
  };
}
