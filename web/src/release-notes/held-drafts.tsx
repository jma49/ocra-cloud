import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { HeldReleaseDraftView, HeldReleasePublishAnswer } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ago } from "../format.js";
import { ActionError, useAction } from "../ui.js";
import { REFUSAL } from "./refusal.js";

// The drafts ocra Cloud holds for a platform that keeps none: each is
// published as a release, which makes its tag, or discarded.

function HeldDraft(props: { draft: HeldReleaseDraftView; gone: () => void }) {
  const { draft } = props;
  const [answer, setAnswer] = useState<HeldReleasePublishAnswer | null>(null);
  const publish = useAction(() =>
    api<HeldReleasePublishAnswer>(`/release-notes/held/${encodeURIComponent(draft.id)}/publish`, {
      method: "POST",
      body: JSON.stringify({ version: draft.version }),
    }),
  );
  const discard = useAction(() =>
    api(`/release-notes/held/${encodeURIComponent(draft.id)}?version=${draft.version}`, {
      method: "DELETE",
    }),
  );
  const published = answer?.outcome === "published";
  return (
    <li>
      <div className="list-row">
        <div className="grow">
          <div>
            <span className="mono strong">{draft.tag}</span>
            {draft.name !== draft.tag && <span> {draft.name}</span>}
          </div>
          <div className="subtle small">
            {published ? "Published" : "Tag made at"} <span className="mono">{draft.target}</span>
            {!published && ` when published · saved ${ago(draft.updatedAt)}`}
          </div>
        </div>
        {published ? (
          <a href={answer.url} target="_blank" rel="noreferrer">
            Open the release
          </a>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              loading={publish.busy}
              disabled={discard.busy}
              onClick={async () => setAnswer((await publish.run()) ?? null)}
            >
              Publish {draft.tag}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={publish.busy || discard.busy}
              aria-label={`Discard the draft of ${draft.tag}`}
              onClick={async () => {
                if (await discard.run()) props.gone();
              }}
            >
              Discard
            </Button>
          </>
        )}
      </div>
      {publish.error !== null && <ActionError what="publish the release" error={publish.error} />}
      {discard.error !== null && <ActionError what="discard the draft" error={discard.error} />}
      {answer && answer.outcome !== "published" && (
        <p className="error held-refusal" role="alert">
          {answer.outcome === "tag_exists"
            ? "That tag, or a release of it, already exists."
            : REFUSAL[answer.outcome]}
        </p>
      )}
    </li>
  );
}

export function HeldDrafts(props: { drafts: HeldReleaseDraftView[]; gone: (id: string) => void }) {
  return (
    <section className="held-drafts" aria-label="Held drafts">
      <h3 className="quiet-label">Held drafts</h3>
      <ul className="rule-list">
        {props.drafts.map((d) => (
          <HeldDraft key={d.id} draft={d} gone={() => props.gone(d.id)} />
        ))}
      </ul>
    </section>
  );
}
