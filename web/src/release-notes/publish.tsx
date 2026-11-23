import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MAX_RELEASE_NAME_CHARS,
  type ReleaseNotesView,
  type ReleasePublishAnswer,
  type ReleasePublishRequest,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ActionError, useAction } from "../ui.js";

// Saves the edited notes as a draft release on the platform, as the user.

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
      } satisfies ReleasePublishRequest),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAnswer(null);
    const a = await save.run();
    if (a) setAnswer(a);
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
          The draft is made on the platform as you, with the notes as they read above. It is not
          published, and no tag is made until you publish it there.
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
    </form>
  );
}
