import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PullSinceOption, PullSinceView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { Seg, useLoad } from "../ui.js";

const SOURCE: Record<PullSinceOption["source"], string> = {
  reviewed: "your last review",
  seen: "your last visit",
};

// A toggle needs a value that is not empty for the whole diff.
const ALL = "all";

const short = (sha: string) => sha.slice(0, 7);

export type Since = ReturnType<typeof useSince>;

/**
 * The heads the pull request can be compared from, and the comparison from
 * the one picked. The first answer is read before the page marks the pull
 * request seen, so its options still say what the last visit read.
 */
export function useSince(query: string, filter = "") {
  const [picked, pick] = useState<string | null>(null);
  const first = useLoad(() => api<PullSinceView>(`/pulls/since?${query}`), [query]);
  const offered = first.data?.since ?? null;
  // The first answer names what can be compared from; a filtered diff is read on its own.
  const other = useLoad(
    () =>
      picked && (picked !== offered || filter)
        ? api<PullSinceView>(`/pulls/since?${query}&since=${picked}${filter}`)
        : Promise.resolve(null),
    [query, picked, offered, filter],
  );
  // Two sources may name one head: the first, the review, keeps it.
  const options = (first.data?.options ?? []).filter(
    (o, i, all) => all.findIndex((x) => x.head === o.head) === i,
  );
  const reading = picked !== null && (picked !== offered || filter !== "");
  return {
    /** True once the first answer is in, or failed: the page may mark the pull request seen. */
    ready: !first.loading,
    options,
    picked,
    pick,
    loading: reading && other.loading,
    failed: reading && Boolean(other.error),
    view: picked === null ? null : reading ? (other.data ?? null) : (first.data ?? null),
  };
}

/** The files to show instead of the whole diff, or null to show the whole diff. */
export function sinceFiles(since: Since): PullSinceView["files"] | null {
  if (since.picked === null || since.failed) return null;
  if (since.loading || !since.view) return [];
  const { state } = since.view;
  if (state === "changes") return since.view.files;
  return state === "same" || state === "rebased" ? [] : null;
}

export function SinceBar(props: { since: Since }) {
  const { since } = props;
  if (since.options.length === 0) return null;
  const option = since.options.find((o) => o.head === since.picked);
  const from = option ? `${SOURCE[option.source]} (${short(option.head)})` : "";
  const state = since.failed ? "unavailable" : since.view?.state;
  return (
    <section className="stack-tight" aria-label="Changes shown">
      <Seg
        label="Changes shown"
        value={since.picked ?? ALL}
        onChange={(v) => since.pick(v === ALL ? null : v)}
        options={[
          { value: ALL, label: "All changes" },
          ...since.options.map((o) => ({
            value: o.head,
            label: `Since ${SOURCE[o.source]} · ${short(o.head)}`,
          })),
        ]}
      />
      {since.loading && <p className="muted small m-0">Reading the changes…</p>}
      {!since.loading && option && state === "changes" && (
        <p className="muted small m-0">
          Comments and fixes are on the whole diff: this view only reads.
          {since.view?.truncated && " More changed than one page reads; these are the first files."}
        </p>
      )}
      {!since.loading && state === "same" && (
        <p className="muted small m-0" role="status">
          Nothing new since {from}.
        </p>
      )}
      {!since.loading && state === "rebased" && (
        <div className="row-gap" role="status">
          <span className="muted small">
            Force-pushed since {from}: its commits are no longer in this pull request.
          </span>
          <Button variant="outline" size="sm" onClick={() => since.pick(null)}>
            Show all changes
          </Button>
        </div>
      )}
      {!since.loading && option && (state === "unavailable" || state === "none") && (
        <p className="muted small m-0" role="status">
          The platform could not compare from {from}: showing all changes.
        </p>
      )}
    </section>
  );
}
