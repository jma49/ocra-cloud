import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  FixProposalView,
  LineComment,
  PullActionOutcome,
  PullFindingView,
} from "../../../src/shared/index.js";
import { FixProposal } from "../fixes/fix-proposal.js";
import { anchorOf, type DiffLine } from "./diff.js";
import { lineName } from "./diff-row.js";
import { FindingNote } from "./findings.js";
import { SuggestionText } from "./suggestion.js";

// What sits under a line of the diff: ocra's findings and fixes for it, the
// comments waiting in the page's review, and the box a new one is written in.

export type Notes = {
  findingsAt: ReadonlyMap<number, PullFindingView[]>;
  fixesAt: ReadonlyMap<number, FixProposalView[]>;
  review: string | null;
  /** A finding marked fixed or dismissed here (true), or put back (false). */
  onDecided: (finding: string, decided: boolean) => void;
  onFixDone: (outcome: PullActionOutcome) => void;
  pendingAt: (line: number) => LineComment[];
  onDrop: (c: LineComment) => void;
};

/** Whether anything sits under the line, so a run holding it is measured, not guessed. */
export const hasNotes = (notes: Notes, at: number) =>
  Boolean(notes.findingsAt.get(at)?.length || notes.fixesAt.get(at)?.length) ||
  notes.pendingAt(at).length > 0;

export function LineNotes(props: { at: number; notes: Notes; columns: number }) {
  const { notes, at, columns } = props;
  const { review } = notes;
  // What is wrong, then what would fix it, then what the reviewer wrote.
  return (
    <>
      {review &&
        notes.findingsAt.get(at)?.map((f) => (
          <tr key={f.id} className="diff-note">
            <td colSpan={columns}>
              <FindingNote finding={f} onDecided={(d) => notes.onDecided(f.id, d)} />
            </td>
          </tr>
        ))}
      {notes.fixesAt.get(at)?.map((fix) => (
        <tr key={fix.finding} className="diff-note">
          <td colSpan={columns}>
            <FixProposal fix={fix} onDone={notes.onFixDone} />
          </td>
        </tr>
      ))}
      {notes.pendingAt(at).map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two comments on one line may be alike; their order is fixed.
        <tr key={i} className="diff-note">
          <td colSpan={columns}>
            <div className="diff-comment">
              <div className="stack grow">
                {c.body && <span className="pre-wrap">{c.body}</span>}
                {c.suggestion !== undefined && <SuggestionText text={c.suggestion} />}
              </div>
              <Button variant="outline" size="sm" onClick={() => notes.onDrop(c)}>
                Remove
              </Button>
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

/** The box a comment on one line is written in, with an optional suggested replacement. */
export function CommentBox(props: {
  path: string;
  line: DiffLine;
  columns: number;
  onAdd: (c: LineComment) => void;
  onCancel: () => void;
}) {
  const { line } = props;
  const [draft, setDraft] = useState("");
  // A suggestion replaces the commented new line; null while the comment carries none.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const add = () => {
    const a = anchorOf(line);
    if (!a || (!draft.trim() && suggestion === null)) return;
    props.onAdd({
      path: props.path,
      ...a,
      body: draft.trim(),
      ...(suggestion !== null && a.side === "new" ? { suggestion } : {}),
    });
  };
  return (
    <tr className="diff-note">
      <td colSpan={props.columns}>
        <div className="diff-comment-box">
          <textarea
            className="input"
            aria-label={`Your comment on ${lineName(line)}`}
            placeholder="Leave a comment"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {line.kind !== "del" &&
            (suggestion === null ? (
              <Button variant="outline" size="sm" onClick={() => setSuggestion(line.text)}>
                Suggest a change
              </Button>
            ) : (
              <div className="stack-tight">
                <div className="row-gap suggest-head">
                  <span className="subtle small grow">
                    Replaces {lineName(line)} when committed
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setSuggestion(null)}>
                    Remove suggestion
                  </Button>
                </div>
                <textarea
                  className="input mono suggest-input"
                  aria-label={`Suggested text for ${lineName(line)}`}
                  rows={Math.max(2, suggestion.split("\n").length)}
                  spellCheck={false}
                  value={suggestion}
                  onChange={(e) => setSuggestion(e.target.value)}
                />
              </div>
            ))}
          <div className="row-gap">
            <Button size="sm" disabled={!draft.trim() && suggestion === null} onClick={add}>
              Add to review
            </Button>
            <Button variant="outline" size="sm" onClick={props.onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </td>
    </tr>
  );
}
