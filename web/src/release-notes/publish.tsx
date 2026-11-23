import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type HeldReleaseDraftView,
  type HeldReleasePublishAnswer,
  MAX_RELEASE_NAME_CHARS,
  type ReleaseNotesView,
  type ReleasePublishAnswer,
  type ReleasePublishRequest,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ActionError, useAction } from "../ui.js";

// Saves the edited notes as a draft release on the platform, as the user;
// on GitLab, which keeps no draft releases, ocra Cloud holds the draft
// until the user publishes it from here.

/** The tag after this one: its last number, one higher. Null for a tag without a number. */
export function nextTag(tag: string): string | null {
  const m = /^(.*?)(\d+)(\D*)$/.exec(tag);
  return m ? `${m[1]}${Number(m[2]) + 1}${m[3]}` : null;
}

const REFUSAL: Record<"target_missing" | "refused" | "unsupported", string> = {
  target_missing: "The target is not a branch or commit of this repository.",
  refused: "The platform refused: your account may not make releases in this repository.",
  unsupported: "This platform keeps no draft releases. Copy the Markdown into a release there.",
};

export function PublishDraft(props: { notes: ReleaseNotesView; body: string }) {
  const { notes } = props;
  const [tag, setTag] = useState("");
  const [target, setTarget] = useState(notes.to);
  const [name, setName] = useState("");
  const [answer, setAnswer] = useState<ReleasePublishAnswer | null>(null);
  const [held, setHeld] = useState<HeldReleaseDraftView[]>(notes.held ?? []);
  const holds = notes.held !== undefined;
  const save = useAction(() =>
    api<ReleasePublishAnswer>("/release-notes/publish", {
      method: "POST",
      body: JSON.stringify({
        platform: notes.platform,
        repo: notes.repo,
        tag: tag.trim(),
        target: target.trim(),
        name: name.trim() || tag.trim(),
        body: props.body,
        draft: true,
        version: held.find((d) => d.tag === tag.trim())?.version,
      } satisfies ReleasePublishRequest),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAnswer(null);
    const a = await save.run();
    if (a) setAnswer(a);
    if (a?.outcome === "held") setHeld((h) => [a.draft, ...h.filter((d) => d.id !== a.draft.id)]);
  };
  const next = answer?.outcome === "tag_exists" ? nextTag(tag.trim()) : null;

  return (
    <form
      className="section card card-pad stack"
      aria-label="Save a draft release"
      onSubmit={submit}
    >
      <div>
        <h2 className="card-title">Save as a draft release</h2>
        <p className="muted small m-0">
          {holds
            ? "This platform keeps no draft releases, so ocra Cloud holds the draft, with the notes as they read above, until you publish it here. No tag is made until then."
            : "The draft is made on the platform as you, with the notes as they read above. It is not published, and no tag is made until you publish it there."}
        </p>
      </div>
      <div className="release-fields">
        <label>
          <span className="small">Tag</span>
          <input
            className="input mono"
            aria-label="Tag"
            placeholder="v1.5.0"
            maxLength={200}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
        </label>
        <label>
          <span className="small">Target</span>
          <input
            className="input mono"
            aria-label="Target"
            maxLength={200}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
        <label className="grow">
          <span className="small">Name</span>
          <input
            className="input"
            aria-label="Release name"
            placeholder={tag.trim() || "The tag, unless you name it"}
            maxLength={MAX_RELEASE_NAME_CHARS}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Button type="submit" disabled={save.busy || !tag.trim() || !target.trim()}>
          Save draft release
        </Button>
      </div>
      {save.error !== null && <ActionError what="save the draft release" error={save.error} />}
      {answer && (answer.outcome === "created" || answer.outcome === "updated") && (
        <p className="note ok m-0" role="status">
          {answer.outcome === "created"
            ? "Draft release made."
            : "The tag's draft release is updated."}{" "}
          <a href={answer.release.url} target="_blank" rel="noreferrer">
            Open it on the platform
          </a>{" "}
          to publish it.
        </p>
      )}
      {answer?.outcome === "held" && (
        <p className="note ok m-0" role="status">
          Draft of {answer.draft.tag} held. Publish it below when it is ready.
        </p>
      )}
      {answer?.outcome === "tag_exists" && (
        <p className="error m-0" role="alert">
          That tag, or a published release of it, already exists.{" "}
          {next && (
            <Button type="button" variant="outline" size="sm" onClick={() => setTag(next)}>
              Use {next}
            </Button>
          )}
        </p>
      )}
      {answer &&
        (answer.outcome === "target_missing" ||
          answer.outcome === "refused" ||
          answer.outcome === "unsupported") && (
          <p className="error m-0" role="alert">
            {REFUSAL[answer.outcome]}
          </p>
        )}
      {held.length > 0 && (
        <ul className="stack m-0" aria-label="Held drafts">
          {held.map((d) => (
            <HeldDraft
              key={d.id}
              draft={d}
              gone={() => setHeld((h) => h.filter((x) => x.id !== d.id))}
            />
          ))}
        </ul>
      )}
    </form>
  );
}

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
  return (
    <li className="stack">
      <div className="release-fields">
        <span className="mono grow">
          {draft.tag} <span className="muted small">{draft.name}</span>
        </span>
        {answer?.outcome === "published" ? (
          <a href={answer.url} target="_blank" rel="noreferrer">
            Open the release
          </a>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              disabled={publish.busy}
              onClick={async () => setAnswer((await publish.run()) ?? null)}
            >
              Publish {draft.tag}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={discard.busy}
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
        <p className="error m-0" role="alert">
          {answer.outcome === "tag_exists"
            ? "That tag, or a release of it, already exists."
            : REFUSAL[answer.outcome]}
        </p>
      )}
    </li>
  );
}
