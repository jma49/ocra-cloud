import type { Row, Scoped } from "./db/scoped.js";
import type { FileRead } from "./platforms/files.js";

// The open findings of reviews of a pull request's earlier heads that no
// review of the head shown has taken a word on, for its page to list apart
// from the diff. Each is outdated once the lines it is about changed since
// its head, as a platform marks a thread on changed lines; it is never left
// out for that.

/** Reviews of the pull request looked through, newest first. */
const MAX_REVIEWS = 40;
/** Earlier findings answered at most, newest first. */
const MAX_EARLIER = 30;

export type Earlier = { finding: Row<"findings">; head: string };

/**
 * Of reviews newest first, the open findings of those of another head than
 * `head`, one per fingerprint (the newest review's word stands), leaving out
 * every fingerprint a review of `head` holds, whatever its status there.
 */
export function earlierOpen(
  reviews: { review: Row<"reviews">; findings: Row<"findings">[] }[],
  head: string,
): Earlier[] {
  const seen = new Set(
    reviews
      .filter((r) => r.review.prHeadSha === head)
      .flatMap((r) => r.findings.map((f) => f.fingerprint)),
  );
  const out: Earlier[] = [];
  for (const { review, findings } of reviews) {
    const at = review.prHeadSha;
    if (!at || at === head) continue;
    for (const f of findings) {
      if (seen.has(f.fingerprint)) continue;
      seen.add(f.fingerprint);
      if (f.status === "open") out.push({ finding: f, head: at });
    }
  }
  return out.slice(0, MAX_EARLIER);
}

export async function openBefore(
  data: Scoped,
  pull: { prRepository: string; prNumber: number },
  head: string,
): Promise<Earlier[]> {
  const reviews = await data.listNewest("reviews", MAX_REVIEWS, pull);
  const findings = await Promise.all(reviews.map((r) => data.findingsOf(r.id)));
  return earlierOpen(
    reviews.map((review, i) => ({ review, findings: findings[i] ?? [] })),
    head,
  );
}

type Reader = (commit: string, paths: string[]) => Promise<FileRead[] | null>;

const linesOf = (bytes: Uint8Array) =>
  new TextDecoder()
    .decode(bytes)
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

/**
 * Whether each finding's lines changed between its head and `head`: its file
 * gone or changed for one about the whole file, the lines of its range not the
 * same for one about lines. A file that could not be read leaves its
 * findings not outdated, so nothing is marked on a guess.
 */
export async function outdatedOf(earlier: Earlier[], head: string, read: Reader) {
  const paths = (list: Earlier[]) => [...new Set(list.map((e) => e.finding.file))];
  const byHead = new Map<string, Earlier[]>();
  for (const e of earlier) byHead.set(e.head, [...(byHead.get(e.head) ?? []), e]);
  const [now, ...before] = await Promise.all([
    read(head, paths(earlier)),
    ...[...byHead].map(([at, list]) => read(at, paths(list))),
  ]);
  const files = (reads: FileRead[] | null | undefined) =>
    new Map((reads ?? []).map((r) => [r.path, r]));
  const current = files(now);
  const then = new Map([...byHead.keys()].map((at, i) => [at, files(before[i])]));
  return earlier.map(({ finding: f, head: at }) => {
    const was = then.get(at)?.get(f.file);
    const is = current.get(f.file);
    if (!now || !was || was.blobId === "" || is?.blobId === "") return false;
    if (was.blobId === null) return false;
    if (!is || is.blobId === null) return true;
    if (is.blobId === was.blobId) return false;
    const start = f.lineStart;
    if (start === null) return true;
    if (!was.bytes || !is.bytes) return false;
    const end = f.lineEnd ?? start;
    const range = (bytes: Uint8Array) =>
      linesOf(bytes)
        .slice(start - 1, end)
        .join("\n");
    return range(was.bytes) !== range(is.bytes);
  });
}
