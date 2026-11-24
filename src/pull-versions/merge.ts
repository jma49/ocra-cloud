import type { KeptVersion } from "../db/pull-versions.js";
import type { PlatformVersions } from "../platforms/versions.js";
import type { PullVersion, PullVersionKind } from "../shared/index.js";

// One list of a pull request's versions from the heads ocra's webhooks kept
// and those its platform still lists: one version per head, ordered by when
// it was pushed (else when its commit was made), numbered from 1.

type Known = { head: string; pushedAt: Date | null; at: Date; rewrite: boolean | null };

export type NumberedVersions = { versions: PullVersion[]; complete: boolean };

const earlier = (a: Date | null, b: Date | null) =>
  a === null ? b : b === null ? a : a <= b ? a : b;

export function numberVersions(
  kept: readonly KeptVersion[],
  listed: PlatformVersions | null,
  head: string,
  now: Date,
): NumberedVersions {
  const known = new Map<string, Known>();
  for (const k of kept) {
    known.set(k.head, { head: k.head, pushedAt: k.pushedAt, at: k.pushedAt, rewrite: null });
  }
  for (const v of listed?.versions ?? []) {
    const was = known.get(v.head);
    const pushedAt = earlier(was?.pushedAt ?? null, v.pushedAt);
    known.set(v.head, {
      head: v.head,
      pushedAt,
      at: pushedAt ?? earlier(was?.at ?? null, v.at) ?? v.at,
      rewrite: v.rewrite ?? was?.rewrite ?? null,
    });
  }
  if (!known.has(head)) known.set(head, { head, pushedAt: null, at: now, rewrite: null });
  const ordered = [...known.values()].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || (a.head < b.head ? -1 : 1),
  );
  const opened = kept.some((k) => k.opened && ordered[0]?.head === k.head);
  const complete = opened || listed?.fromStart === true;
  const kindOf = (v: Known, i: number): PullVersionKind | null => {
    if (i === 0) return complete ? "first" : null;
    if (v.rewrite !== null) return v.rewrite ? "rewrite" : "fast_forward";
    return listed?.namesRewrites ? "fast_forward" : null;
  };
  return {
    versions: ordered.map((v, i) => ({
      version: i + 1,
      head: v.head,
      pushedAt: v.pushedAt?.toISOString() ?? null,
      kind: kindOf(v, i),
    })),
    complete,
  };
}
