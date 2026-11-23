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

/** Merge now, after one confirmation: the platform refuses what it does not allow. */
export function MergeNow(props: {
  data: PullFilesView;
  pull: Ref;
  method: MergeMethod;
  /** Whether merging is the pull request's next step. */
  primary: boolean;
  onDone: (o: PullActionOutcome) => void;
}) {
  const label = methodLabels(props.pull.platform);
  const [asking, setAsking] = useState(false);
  const merge = useAction(() =>
    api<{ outcome: PullActionOutcome }>("/pulls/merge", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, method: props.method, head: props.data.head }),
    }),
  );
  const confirm = async () => {
    const r = await merge.run();
    setAsking(false);
    if (r) props.onDone(r.outcome);
  };
  return (
    <>
      {asking ? (
        <div className="row-gap">
          <Button className="grow" disabled={merge.busy} onClick={confirm}>
            Confirm: {label[props.method].toLowerCase()}
          </Button>
          <Button variant="outline" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant={props.primary ? "default" : "outline"} onClick={() => setAsking(true)}>
          Merge pull request
        </Button>
      )}
      {merge.error !== null && (
        <p className="error" role="alert">
          Could not merge: {why(merge.error)}.
        </p>
      )}
    </>
  );
}
