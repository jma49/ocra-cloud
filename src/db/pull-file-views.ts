import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { jsonRecords, jsonTexts, randomId } from "./dialect.js";
import type { SeenPull } from "./pull-seen.js";
import { pullFileViews } from "./schema.js";

// The files of a merge request the account ticked as viewed, each with the
// version it had then; GitLab keeps no such state. Reached only through scoped().

export type ViewedFile = { path: string; sha: string };

export function accountPullFileViews(db: Db, accountId: string) {
  const t = pullFileViews;
  const ofPull = (pull: SeenPull) =>
    and(
      eq(t.accountId, accountId),
      eq(t.platform, pull.platform),
      eq(t.repo, pull.repo),
      eq(t.number, pull.number),
    );
  return {
    /** The version each ticked file had when ticked, by path. */
    async versions(pull: SeenPull): Promise<Map<string, string>> {
      const rows = await db.select({ path: t.path, sha: t.sha }).from(t).where(ofPull(pull));
      return new Map(rows.map((r) => [r.path, r.sha]));
    },

    /** Ticks the files at these versions, a file ticked before taking the new one. */
    async mark(pull: SeenPull, files: readonly ViewedFile[]): Promise<void> {
      if (files.length === 0) return;
      const list = JSON.stringify(files);
      // SQLite needs the WHERE before an upsert's ON CONFLICT on INSERT ... SELECT.
      await db.run(sql`INSERT INTO ${t} (id, account_id, platform, repo, number, path, sha, viewed_at)
        SELECT ${randomId(db)}, ${accountId}, ${pull.platform}, ${pull.repo}, ${pull.number},
          je.path, je.sha, ${Date.now()}
        FROM ${jsonRecords(db, list, { path: "text", sha: "text" })}
        WHERE true
        ON CONFLICT (account_id, platform, repo, number, path) DO UPDATE SET
          sha = excluded.sha, viewed_at = excluded.viewed_at`);
    },

    async unmark(pull: SeenPull, paths: readonly string[]): Promise<void> {
      if (paths.length === 0) return;
      const list = JSON.stringify(paths);
      await db.delete(t).where(and(ofPull(pull), sql`${t.path} IN (${jsonTexts(db, list)})`));
    },
  };
}
