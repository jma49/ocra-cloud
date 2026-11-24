import { useState } from "react";
import type {
  CodePlatformKind,
  MergeMethod,
  PullActionOutcome,
  PullFilesView,
} from "../../../src/shared/index.js";
import { methodLabels } from "./merge-method.js";
import { MergeNow } from "./merge-now.js";
import { MergeWhenReady } from "./merge-when-ready.js";

/**
 * Merging in one place: one method, then merge now or merge when ready.
 * Merge now is the primary button once merging is the pull request's next step.
 */
export function MergeCard(props: {
  data: PullFilesView;
  pull: { platform: CodePlatformKind; repo: string; number: number };
  /** Whether it can merge now, as far as its readiness says. */
  ready: boolean;
  /** Whether it conflicts with its base: merge now waits until that is resolved. */
  conflicts: boolean;
  onDone: (o: PullActionOutcome) => void;
}) {
  const { data, pull, ready } = props;
  const label = methodLabels(pull.platform);
  const [method, setMethod] = useState<MergeMethod>(data.mergeMethods[0] ?? "merge");
  return (
    <section className="card card-pad stack" aria-label="Merge">
      <h2 className="card-title">Merge</h2>
      <select
        className="input"
        aria-label="Merge method"
        value={method}
        onChange={(e) => setMethod(e.target.value as MergeMethod)}
      >
        {data.mergeMethods.map((m) => (
          <option key={m} value={m}>
            {label[m]}
          </option>
        ))}
      </select>
      <MergeNow
        data={data}
        pull={pull}
        method={method}
        primary={ready}
        conflicts={props.conflicts}
        onDone={props.onDone}
      />
      <MergeWhenReady pull={pull} head={data.head} method={method} label={label} />
    </section>
  );
}
