import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CodePlatformKind,
  MergeMethod,
  PullActionOutcome,
  PullFilesView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useAction } from "../ui.js";
import { methodLabels } from "./merge-method.js";

type Ref = { platform: CodePlatformKind; repo: string; number: number };

export function MergeBox(props: {
  data: PullFilesView;
  pull: Ref;
  onDone: (o: PullActionOutcome) => void;
}) {
  const methods = props.data.mergeMethods;
  const label = methodLabels(props.pull.platform);
  const [method, setMethod] = useState<MergeMethod>(methods[0] ?? "merge");
  const [asking, setAsking] = useState(false);
  const merge = useAction(() =>
    api<{ outcome: PullActionOutcome }>("/pulls/merge", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, method, head: props.data.head }),
    }),
  );
  const confirm = async () => {
    const r = await merge.run();
    setAsking(false);
    if (r) props.onDone(r.outcome);
  };
  return (
    <section className="card card-pad stack" aria-label="Merge">
      <div className="strong">Merge</div>
      <select
        className="input"
        aria-label="Merge method"
        value={method}
        onChange={(e) => setMethod(e.target.value as MergeMethod)}
      >
        {methods.map((m) => (
          <option key={m} value={m}>
            {label[m]}
          </option>
        ))}
      </select>
      {asking ? (
        <div className="row-gap">
          <Button className="grow" disabled={merge.busy} onClick={confirm}>
            Confirm: {label[method].toLowerCase()}
          </Button>
          <Button variant="outline" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setAsking(true)}>
          Merge pull request
        </Button>
      )}
      {merge.error !== null && (
        <p className="error" role="alert">
          Could not merge: {why(merge.error)}.
        </p>
      )}
    </section>
  );
}
