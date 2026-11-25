import { type SubmitEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CodePlatformKind,
  LineComment,
  PullActionOutcome,
  PullFilesView,
  PullVerdict,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { Drawer } from "../drawer.js";
import { count } from "../format.js";
import { Seg, useAction } from "../ui.js";

// The user's review of the pull request: a verdict, a note and the line
// comments made on the diff, sent together against the head the page read.

const VERDICT: Record<PullVerdict, string> = {
  comment: "Comment",
  approve: "Approve",
  request_changes: "Request changes",
};

type Ref = { platform: CodePlatformKind; repo: string; number: number };

export function ReviewBox(props: {
  data: PullFilesView;
  pull: Ref;
  pending: LineComment[];
  /** Whether the diff shown is the whole one, whose lines take comments. */
  wholeDiff: boolean;
  open: boolean;
  onClose: () => void;
  onDone: (o: PullActionOutcome) => void;
}) {
  const verdicts = props.data.verdicts;
  const [verdict, setVerdict] = useState<PullVerdict>(verdicts[0] ?? "comment");
  const [body, setBody] = useState("");
  const send = useAction(() =>
    api<{ outcome: PullActionOutcome }>("/pulls/review", {
      method: "POST",
      body: JSON.stringify({
        ...props.pull,
        verdict,
        body,
        head: props.data.head,
        comments: props.pending,
      }),
    }),
  );
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const r = await send.run();
    if (!r) return;
    if (r.outcome === "done") setBody("");
    props.onClose();
    props.onDone(r.outcome);
  };
  const empty = verdict !== "approve" && !body.trim() && props.pending.length === 0;
  // The note typed so far is kept while the drawer is closed, to look at the diff again.
  if (!props.open) return null;
  return (
    <Drawer
      title="Your review"
      onClose={props.onClose}
      onSubmit={submit}
      foot={
        <>
          <span className="subtle small grow">
            {props.pending.length === 0
              ? props.wholeDiff
                ? "Click a line number in the diff to comment on that line."
                : "Line comments are made on the whole diff."
              : `${count(props.pending.length, "line comment")} ${props.pending.length === 1 ? "goes" : "go"} with it.`}
          </span>
          <Button type="submit" disabled={send.busy || empty}>
            Submit review
          </Button>
        </>
      }
    >
      <div className="stack">
        {verdicts.length > 1 && (
          <Seg
            label="Verdict"
            value={verdict}
            onChange={setVerdict}
            options={verdicts.map((v) => ({ value: v, label: VERDICT[v] }))}
          />
        )}
        <textarea
          className="input review-note"
          aria-label="Review note"
          placeholder={
            verdicts.includes("approve")
              ? "Leave a note (optional for an approval)"
              : "Leave a note"
          }
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {send.error !== null && (
          <p className="error" role="alert">
            Could not send the review: {why(send.error)}.
          </p>
        )}
      </div>
    </Drawer>
  );
}
