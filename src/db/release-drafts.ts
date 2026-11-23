import { and, desc, eq, sql } from "drizzle-orm";
import type { CodePlatformKind } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { isUniqueViolation } from "./dialect.js";
import { releaseDrafts } from "./schema.js";

// The release notes an account holds until it publishes them on a platform
// that keeps no draft releases (GitLab). One per repository and tag, by the
// unique index; every edit and the publish name the version they read, so
// two tabs never overwrite each other. Reached only through scoped().

type Repo = { platform: CodePlatformKind; repo: string };
type Edit = Repo & { tag: string; target: string; name: string; body: string };

/** `stale`: another save got there first; its version, or null when the draft is gone. */
type Stale = { stale: number | null };

export function accountReleaseDrafts(db: Db, accountId: string) {
  const t = releaseDrafts;
  const own = eq(t.accountId, accountId);
  const ofTag = (e: Repo & { tag: string }) =>
    and(own, eq(t.platform, e.platform), eq(t.repo, e.repo), eq(t.tag, e.tag));
  const versionOf = async (e: Repo & { tag: string }) =>
    (await db.select({ version: t.version }).from(t).where(ofTag(e)).then(first))?.version ?? null;

  return {
    list(repo: Repo, limit: number) {
      return db
        .select()
        .from(t)
        .where(and(own, eq(t.platform, repo.platform), eq(t.repo, repo.repo)))
        .orderBy(desc(t.updatedAt))
        .limit(limit);
    },

    find(id: string) {
      return db
        .select()
        .from(t)
        .where(and(own, eq(t.id, id)))
        .then(first);
    },

    /**
     * Starts the tag's draft (no `version`) or edits the one at `version`.
     * `full` when the account already holds `cap` drafts.
     */
    async save(
      edit: Edit,
      version: number | undefined,
      cap: number,
      now = new Date(),
    ): Promise<typeof t.$inferSelect | Stale | "full"> {
      if (version === undefined) {
        const id = crypto.randomUUID();
        try {
          const inserted = await db.insert(t).select(sql`
            SELECT ${id}, ${accountId}, ${edit.platform}, ${edit.repo}, ${edit.tag},
              ${edit.target}, ${edit.name}, ${edit.body}, 1, ${now.getTime()}, ${now.getTime()}
            WHERE (SELECT count(*) FROM ${t} WHERE ${own}) < ${cap}`);
          if (changedRows(inserted) === 0) return "full";
        } catch (error) {
          if (isUniqueViolation(error)) return { stale: await versionOf(edit) };
          throw error;
        }
        return (await this.find(id)) ?? { stale: null };
      }
      const [updated] = await db
        .update(t)
        .set({
          target: edit.target,
          name: edit.name,
          body: edit.body,
          version: version + 1,
          updatedAt: now,
        })
        .where(and(ofTag(edit), eq(t.version, version)))
        .returning();
      return updated ?? { stale: await versionOf(edit) };
    },

    /** Drops the draft at `version`: once published, or when the user discards it. */
    async remove(id: string, version: number): Promise<"removed" | Stale> {
      const res = await db.delete(t).where(and(own, eq(t.id, id), eq(t.version, version)));
      if (changedRows(res) > 0) return "removed";
      return { stale: (await this.find(id))?.version ?? null };
    },
  };
}
