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
import { useAction } from "../ui.js";

// "Write the PR description": a draft from ocra's review of this pull
// request, edited here and saved to the platform as the user. Only ocra's
// section of the description is redrafted; the rest is the user's text.

type Pull = { platform: string; repo: string; number: number };

export function DescriptionBox(props: { pull: Pull; onDone: (o: PullActionOutcome) => void }) {
  const [draft, setDraft] = useState<PullDescriptionDraftView | null>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const load = useAction(async () => {
    const query = new URLSearchParams({
      platform: props.pull.platform,
      repo: props.pull.repo,
      number: String(props.pull.number),
    });
    const view = await api<PullDescriptionDraftView>(`/pulls/description-draft?${query}`);
    setDraft(view);
    setText(view.draft ?? view.body);
    setOpen(true);
  });
  const save = useAction(() =>
    api<{ outcome: PullActionOutcome }>("/pulls/description", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, head: draft?.head, body: text }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await save.run();
    if (!r) return;
    setOpen(false);
    if (r.outcome === "done") setDraft(null);
    props.onDone(r.outcome);
  };
  const start = draft ? (draft.draft ?? draft.body) : "";
  const tooLong = text.length > MAX_DESCRIPTION_CHARS;
  return (
    <section className="card card-pad stack" aria-label="Description">
      <div className="strong">Description</div>
      <span className="subtle small">
        {draft
          ? "Your draft is kept here until you save it or leave the page."
          : "Drafted from ocra's review, edited by you, saved to the pull request as you."}
      </span>
      {draft ? (
        <div className="row-gap">
          <Button type="button" variant="outline" className="grow" onClick={() => setOpen(true)}>
            Continue the description
          </Button>
          <Button type="button" variant="outline" onClick={() => setDraft(null)}>
            Discard
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" loading={load.busy} onClick={() => load.run()}>
          Write the PR description
        </Button>
      )}
      {load.error !== null && (
        <p className="error" role="alert">
          Could not draft the description: {why(load.error)}.
        </p>
      )}
      {draft && open && (
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
              {text !== start && (
                <Button type="button" variant="outline" onClick={() => setText(start)}>
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
            {draft.review ? (
              <>
                From ocra's review of <span className="mono">{draft.review.head.slice(0, 7)}</span>
                {draft.review.current ? ", the current head" : ", an earlier head"}. Only ocra's
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
            onChange={(e) => setText(e.target.value)}
          />
          {save.error !== null && (
            <p className="error" role="alert">
              Could not save the description: {why(save.error)}.
            </p>
          )}
        </Drawer>
      )}
    </section>
  );
}
