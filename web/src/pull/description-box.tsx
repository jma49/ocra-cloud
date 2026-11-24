import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MAX_DESCRIPTION_CHARS,
  type PullActionOutcome,
  type PullDescriptionDraftView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { Drawer } from "../drawer.js";
import { num } from "../format.js";
import { PlatformMarkdown } from "../platform-markdown.js";
import { useAction } from "../ui.js";

// The pull request's description, read where the diff is, and "Draft with
// ocra": a draft from ocra's review of it, edited here and saved to the
// platform as the user. Only ocra's section of the description is
// redrafted; the rest is the user's text.

type Pull = { platform: string; repo: string; number: number };

/** A description's markers and notes to tools are not for its reader. */
const readable = (body: string) => body.replace(/<!--[\s\S]*?-->/g, "").trim();

export function DescriptionBox(props: {
  pull: Pull;
  /** The description as the platform has it, and ocra's draft of it; undefined until read. */
  view: PullDescriptionDraftView | undefined;
  /** Whether the pull request still takes a new description. */
  editable: boolean;
  onDone: (o: PullActionOutcome) => void;
}) {
  const { view } = props;
  const start = view ? (view.draft ?? view.body) : "";
  // What the user typed and has not saved; it outlives a closed drawer.
  const [edited, setEdited] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const text = edited ?? start;
  const save = useAction(() =>
    api<{ outcome: PullActionOutcome }>("/pulls/description", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, head: view?.head, body: text }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await save.run();
    if (!r) return;
    setOpen(false);
    if (r.outcome === "done") setEdited(null);
    props.onDone(r.outcome);
  };
  if (!view) return null;
  const body = readable(view.body);
  const tooLong = text.length > MAX_DESCRIPTION_CHARS;
  return (
    <details className="pull-part" open>
      <summary className="pull-part-head">
        <span className="fold" aria-hidden="true" />
        <h2 className="card-title grow">Description</h2>
        {props.editable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.preventDefault();
              setOpen(true);
            }}
          >
            {edited !== null ? "Continue editing" : view.draft ? "Draft with ocra" : "Edit"}
          </Button>
        )}
      </summary>
      <div className="pull-description">
        {body ? (
          <PlatformMarkdown text={body} />
        ) : (
          <p className="subtle m-0">No description yet.</p>
        )}
      </div>
      {open && (
        <Drawer
          title="Description"
          heading="Pull request description"
          onClose={() => setOpen(false)}
          onSubmit={submit}
          foot={
            <>
              <span className={`small grow ${tooLong ? "error-inline" : "subtle"}`}>
                {num(text.length)} of {num(MAX_DESCRIPTION_CHARS)} characters
              </span>
              {edited !== null && edited !== start && (
                <Button type="button" variant="outline" onClick={() => setEdited(null)}>
                  Start over
                </Button>
              )}
              <Button type="submit" loading={save.busy} disabled={tooLong}>
                Save description
              </Button>
            </>
          }
        >
          <p className="muted small m-0">
            {view.review ? (
              <>
                From ocra's review of <span className="mono">{view.review.head.slice(0, 7)}</span>
                {view.review.current ? ", the current head" : ", an earlier head"}. Only ocra's
                section is redrafted; your own text around it is kept.
              </>
            ) : (
              "ocra has not reviewed this pull request yet: this is its description as it is."
            )}
          </p>
          <textarea
            className="input mono description-text"
            aria-label="Pull request description"
            spellCheck={false}
            value={text}
            onChange={(e) => setEdited(e.target.value)}
          />
          {save.error !== null && (
            <p className="error" role="alert">
              Could not save the description: {why(save.error)}.
            </p>
          )}
        </Drawer>
      )}
    </details>
  );
}
