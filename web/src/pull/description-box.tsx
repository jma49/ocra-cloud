import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MAX_DESCRIPTION_CHARS,
  type PullActionOutcome,
  type PullDescriptionDraftView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useAction } from "../ui.js";

// "Write the PR description": a draft from ocra's review of this pull
// request, edited here and saved to the platform as the user. Only ocra's
// section of the description is redrafted; the rest is the user's text.

type Pull = { platform: string; repo: string; number: number };

export function DescriptionBox(props: { pull: Pull; onDone: (o: PullActionOutcome) => void }) {
  const [draft, setDraft] = useState<PullDescriptionDraftView | null>(null);
  const [text, setText] = useState("");
  const load = useAction(async () => {
    const query = new URLSearchParams({
      platform: props.pull.platform,
      repo: props.pull.repo,
      number: String(props.pull.number),
    });
    const view = await api<PullDescriptionDraftView>(`/pulls/description-draft?${query}`);
    setDraft(view);
    setText(view.draft ?? view.body);
  });
  const save = useAction(() =>
    api<{ outcome: PullActionOutcome }>("/pulls/description", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, head: draft?.head, body: text }),
    }),
  );
  const submit = async () => {
    const r = await save.run();
    if (!r) return;
    if (r.outcome === "done") setDraft(null);
    props.onDone(r.outcome);
  };
  const tooLong = text.length > MAX_DESCRIPTION_CHARS;
  return (
    <section className="card card-pad stack" aria-label="Description">
      <div className="strong">Description</div>
      {!draft ? (
        <Button type="button" variant="outline" disabled={load.busy} onClick={() => load.run()}>
          Write the PR description
        </Button>
      ) : (
        <>
          <span className="subtle small">
            {draft.review
              ? `From ocra's review of ${draft.review.head.slice(0, 7)}${draft.review.current ? ", the current head" : ", an earlier head"}. Your own text outside ocra's section is kept.`
              : "ocra has not reviewed this pull request yet: this is its description as it is."}
          </span>
          <textarea
            className="input"
            aria-label="Pull request description"
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {tooLong && (
            <p className="error" role="alert">
              The description is longer than {MAX_DESCRIPTION_CHARS} characters.
            </p>
          )}
          <Button disabled={save.busy || tooLong} onClick={submit}>
            Save description
          </Button>
        </>
      )}
      {load.error !== null && (
        <p className="error" role="alert">
          Could not draft the description: {why(load.error)}.
        </p>
      )}
      {save.error !== null && (
        <p className="error" role="alert">
          Could not save the description: {why(save.error)}.
        </p>
      )}
    </section>
  );
}
