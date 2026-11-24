import { useState } from "react";
import type {
  PullFileView,
  PullVersion,
  PullVersionCompareView,
  PullVersionsView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ago } from "../format.js";
import { useLoad } from "../ui.js";

// A pull request's versions, one per push, and the diff between any two:
// what changed from v3 to v5, a force push's included.

export type Versions = ReturnType<typeof useVersions>;

type Range = { from: string; to: string };

export function useVersions(query: string, head: string | undefined) {
  const list = useLoad(
    () => (head ? api<PullVersionsView>(`/pulls/versions?${query}`) : Promise.resolve(null)),
    [query, head],
  );
  const [range, setRange] = useState<Range | null>(null);
  const compared = useLoad(
    () =>
      range
        ? api<PullVersionCompareView>(
            `/pulls/versions/compare?${query}&from=${range.from}&to=${range.to}`,
          )
        : Promise.resolve(null),
    [query, range?.from, range?.to],
  );
  const versions = list.data?.versions ?? [];
  return {
    versions,
    complete: list.data?.complete ?? true,
    range,
    /** The last push against the one before it, the range a picker opens on. */
    openLatest: () => {
      const [from, to] = versions.slice(-2);
      if (from && to) setRange({ from: from.head, to: to.head });
    },
    pick: setRange,
    loading: range !== null && compared.loading,
    failed: range !== null && Boolean(compared.error),
    view: range ? (compared.data ?? null) : null,
  };
}

/** The files to show instead of the whole diff, or null to show the whole diff. */
export function versionFiles(v: Versions): PullFileView[] | null {
  if (v.range === null || v.failed) return null;
  if (v.loading || !v.view) return [];
  if (v.view.state === "changes") return v.view.files;
  return v.view.state === "same" ? [] : null;
}

const KIND: Record<NonNullable<PullVersion["kind"]>, string> = {
  first: "opened",
  fast_forward: "pushed",
  rewrite: "force-pushed",
};

const label = (v: PullVersion, last: boolean) =>
  [`v${v.version}`, v.kind && KIND[v.kind], v.pushedAt && ago(v.pushedAt), last && "latest"]
    .filter(Boolean)
    .join(" · ");

function Pick(props: {
  label: string;
  value: string;
  versions: PullVersion[];
  disabled: (v: PullVersion) => boolean;
  onChange: (head: string) => void;
}) {
  const last = props.versions.at(-1)?.head;
  return (
    <select
      className="input version-pick"
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.versions.map((v) => (
        <option key={v.head} value={v.head} disabled={props.disabled(v)}>
          {label(v, v.head === last)}
        </option>
      ))}
    </select>
  );
}

/** The two versions compared, and what the compare came to. */
export function VersionPicker(props: { versions: Versions }) {
  const { versions: v } = props;
  if (!v.range) return null;
  const { from, to } = v.range;
  const at = (head: string) => v.versions.find((x) => x.head === head)?.version ?? 0;
  return (
    <div className="stack-tight">
      <div className="row-gap version-range">
        <Pick
          label="From version"
          value={from}
          versions={v.versions}
          disabled={(x) => x.version >= at(to)}
          onChange={(head) => v.pick({ from: head, to })}
        />
        <span className="subtle small">to</span>
        <Pick
          label="To version"
          value={to}
          versions={v.versions}
          disabled={(x) => x.version <= at(from)}
          onChange={(head) => v.pick({ from, to: head })}
        />
      </div>
      {v.loading && <p className="muted small m-0">Comparing the versions…</p>}
      {!v.loading && v.view?.state === "same" && (
        <p className="muted small m-0" role="status">
          Both versions are the same commit.
        </p>
      )}
      {!v.loading && (v.failed || v.view?.state === "unavailable") && (
        <p className="muted small m-0" role="status">
          The platform could not compare these versions: showing all changes.
        </p>
      )}
      {!v.loading && v.view?.state === "changes" && (
        <p className="muted small m-0">
          {v.view.compare === "trees"
            ? "History was rewritten between them, so their trees are compared. "
            : ""}
          {v.view.lines
            ? "Comments and fixes are on the whole diff: this view only reads."
            : "The platform names the files that changed between them, not their lines."}
          {v.view.truncated && " More changed than one page reads; these are the first files."}
        </p>
      )}
      {!v.complete && (
        <span className="subtle small">
          Pushes before ocra watched this pull request are not listed.
        </span>
      )}
    </div>
  );
}
