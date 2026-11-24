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

/** Where the platform resolves a pull request's conflicts: GitHub's own page for it, else the pull request. */
const conflictsPage = (platform: CodePlatformKind, url: string) =>
  platform === "github" ? `${url}/conflicts` : url;

/** Merge now, after one confirmation: the platform refuses what it does not allow. */
export function MergeNow(props: {
  data: PullFilesView;
  pull: Ref;
  method: MergeMethod;
  /** Whether merging is the pull request's next step. */
  primary: boolean;
  /** Whether it conflicts with its base, which no merge gets past. */
  conflicts: boolean;
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
        <Button
          variant={props.primary ? "default" : "outline"}
          disabled={props.conflicts}
          onClick={() => setAsking(true)}
        >
          Merge pull request
        </Button>
      )}
      {props.conflicts && !asking && (
        <p className="subtle small m-0">
          It conflicts with its base branch. Resolve the conflicts
          {props.data.url ? (
            <>
              {" "}
              <a
                href={conflictsPage(props.pull.platform, props.data.url)}
                target="_blank"
                rel="noopener noreferrer"
              >
                on the platform
              </a>
            </>
          ) : null}
          , then merge.
        </p>
      )}
      {merge.error !== null && (
        <p className="error" role="alert">
          Could not merge: {why(merge.error)}.
        </p>
      )}
    </>
  );
}
