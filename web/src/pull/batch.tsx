import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type BatchItem,
  type BatchSkipReason,
  MAX_BATCH_ITEMS,
  type PullBatchView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { count } from "../format.js";
import { useAction } from "../ui.js";
import { OUTCOME } from "./outcome.js";

// ocra's fixes and reviewers' suggestions chosen across the page, committed
// together as one commit of the head the page read. Where two change the same
// lines differently the server keeps the one chosen first, so the choice
// keeps its order.

/** A chosen item and what the page calls it when it says how it went. */
export type Pick = BatchItem & { label: string };

type Batch = {
  picks: readonly Pick[];
  has: (item: BatchItem) => boolean;
  toggle: (pick: Pick) => void;
  /** No more can be chosen. */
  full: boolean;
  /** Counts the commits made, for what must be read again after one. */
  commits: number;
};

const BatchContext = createContext<Batch | null>(null);

/** The page's batch; null on a page that commits each fix by itself. */
export const useBatch = () => useContext(BatchContext);

const same = (a: BatchItem, b: BatchItem) => a.kind === b.kind && a.id === b.id;

const SKIPPED: Record<BatchSkipReason, string> = {
  not_found: "it is no longer on this pull request",
  no_fix: "ocra has no checked fix for it",
  stale: "it was written for an older head, or its lines changed since",
  conflict: "one chosen before it changes the same lines differently",
  not_applicable: "its lines are not in the file",
  not_sent: "not committed",
};

type Pull = { platform: string; repo: string; number: number };
type Result = { view: PullBatchView; picks: readonly Pick[] };

/** Holds the choice for the page below it, and shows the bar that commits it. */
export function PullBatch(props: {
  pull: Pull;
  head: string;
  /** The head moved: what the page read is out of date. The bar itself says how it went. */
  onCommitted: () => void;
  children: ReactNode;
}) {
  const [picks, setPicks] = useState<readonly Pick[]>([]);
  const [commits, setCommits] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const send = useAction(() =>
    api<PullBatchView>("/pulls/apply-batch", {
      method: "POST",
      body: JSON.stringify({
        ...props.pull,
        head: props.head,
        items: picks.map(({ kind, id }) => ({ kind, id })),
      }),
    }),
  );
  const toggle = useCallback((pick: Pick) => {
    setResult(null);
    setPicks((all) =>
      all.some((p) => same(p, pick)) ? all.filter((p) => !same(p, pick)) : [...all, pick],
    );
  }, []);
  const batch = useMemo<Batch>(
    () => ({
      picks,
      has: (item) => picks.some((p) => same(p, item)),
      toggle,
      full: picks.length >= MAX_BATCH_ITEMS,
      commits,
    }),
    [picks, toggle, commits],
  );
  const commit = async () => {
    const view = await send.run();
    if (!view) return;
    setResult({ view, picks });
    if (view.outcome !== "done") return;
    props.onCommitted();
    setPicks([]);
    setCommits((n) => n + 1);
  };
  return (
    <BatchContext.Provider value={batch}>
      {props.children}
      {(picks.length > 0 || result !== null) && (
        <section className="batch-bar" aria-label="Commit together">
          {result && <Outcome result={result} onClose={() => setResult(null)} />}
          {picks.length > 0 && (
            <div className="row-gap batch-row">
              <span className="small grow">
                {picks.length} chosen
                {batch.full && `, the most one commit takes`}
              </span>
              <Button variant="ghost" size="sm" disabled={send.busy} onClick={() => setPicks([])}>
                Clear
              </Button>
              <Button size="sm" loading={send.busy} onClick={commit}>
                {picks.length === 1 ? "Commit 1 change" : `Commit ${picks.length} as one commit`}
              </Button>
            </div>
          )}
          {send.error !== null && (
            <p className="error small m-0" role="alert">
              Could not commit them: {why(send.error)}.
            </p>
          )}
        </section>
      )}
    </BatchContext.Provider>
  );
}

function Outcome(props: { result: Result; onClose: () => void }) {
  const { view, picks } = props.result;
  const applied = view.items.filter((i) => i.applied).length;
  const skipped = view.items.filter((i) => !i.applied);
  const label = (item: BatchItem) => picks.find((p) => same(p, item))?.label ?? item.id;
  return (
    <div className="stack-tight">
      <div className="row-gap batch-row">
        <span
          className={`small grow${view.outcome === "done" ? "" : " error-inline"}`}
          role="status"
        >
          {view.outcome === "done"
            ? `Committed ${applied} of ${count(view.items.length, "change")} as one commit.`
            : view.outcome === "not_applicable"
              ? "None of them could be applied, so nothing was committed."
              : OUTCOME[view.outcome]}
        </span>
        <Button variant="ghost" size="sm" onClick={props.onClose}>
          Dismiss
        </Button>
      </div>
      {view.outcome !== "head_moved" && view.outcome !== "refused" && skipped.length > 0 && (
        <ul className="batch-skipped small">
          {skipped.map((i) => (
            <li key={`${i.kind}:${i.id}`}>
              <span className="strong">{label(i)}</span>
              <span className="subtle">: {SKIPPED[i.reason ?? "not_sent"]}.</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The checkbox that adds an item to the page's batch; nothing where the page has none. */
export function BatchPick(props: { pick: Pick; children: ReactNode }) {
  const batch = useBatch();
  if (!batch) return null;
  const on = batch.has(props.pick);
  return (
    <label
      className="thread-apply small"
      title={!on && batch.full ? `One commit takes at most ${MAX_BATCH_ITEMS} changes.` : undefined}
    >
      <input
        type="checkbox"
        checked={on}
        disabled={!on && batch.full}
        onChange={() => batch.toggle(props.pick)}
      />
      {props.children}
    </label>
  );
}
