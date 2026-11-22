import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CodePlatformKind,
  LearningChangeView,
  LearningView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { listOf, Row } from "../form.js";
import { useAction } from "../ui.js";

// A learning added or changed in the console: committed as the user on a
// new branch opened as a pull request, or on the default branch when asked.

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_BODY = 4000;

/** A file name from a title: lowercase words joined by hyphens. */
export function idFrom(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function LearningForm(props: {
  platform: CodePlatformKind;
  repo: string;
  branch: string;
  learning?: LearningView | undefined;
  done: (change: LearningChangeView | null) => void;
}) {
  const l = props.learning;
  const [title, setTitle] = useState(l?.title ?? "");
  const [id, setId] = useState(l?.id ?? "");
  const [paths, setPaths] = useState(l?.paths.join(", ") ?? "");
  const [symbols, setSymbols] = useState(l?.symbols.join(", ") ?? "");
  const [keywords, setKeywords] = useState(l?.keywords.join(", ") ?? "");
  const [critical, setCritical] = useState(l?.critical ?? false);
  const [body, setBody] = useState(l?.body ?? "");
  const [direct, setDirect] = useState(false);
  const fileId = l ? l.id : id || idFrom(title);

  const save = useAction(() =>
    api<LearningChangeView>("/learnings", {
      method: "POST",
      body: JSON.stringify({
        platform: props.platform,
        repo: props.repo,
        id: fileId,
        direct,
        expected: l?.blobId ?? null,
        learning: {
          title: title.trim(),
          paths: listOf(paths) ?? [],
          symbols: listOf(symbols) ?? [],
          keywords: listOf(keywords) ?? [],
          critical,
          ...(l?.source
            ? { source: { kind: l.source.kind, ...(l.source.ref ? { ref: l.source.ref } : {}) } }
            : { source: { kind: "manual" } }),
          ...(l ? { created: l.created } : {}),
          body: body.trim(),
        },
      }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const change = await save.run();
    if (change) props.done(change);
  };
  const ready = title.trim() !== "" && ID.test(fileId) && listOf(paths) && body.trim() !== "";

  return (
    <form
      className="card learning-form"
      onSubmit={submit}
      aria-label={l ? `Edit ${l.title}` : "New learning"}
    >
      <div className="card-head">
        <h3>{l ? `Edit “${l.title}”` : "New learning"}</h3>
      </div>
      <Row label="Title" desc="One line a reviewer reads first.">
        <input
          className="input"
          aria-label="Title"
          maxLength={200}
          placeholder="Refunds never exceed what was captured"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Row>
      {!l && (
        <Row label="File" desc={`.ocra/learnings/${fileId || "…"}.md`}>
          <input
            className="input mono"
            aria-label="File name"
            maxLength={80}
            placeholder={idFrom(title) || "refund-cap"}
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
        </Row>
      )}
      <Row label="Paths" desc="Globs of the files it applies to, comma-separated.">
        <input
          className="input mono"
          aria-label="Paths"
          placeholder="src/refunds/**"
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
        />
      </Row>
      <Row label="Symbols" desc="Functions or types it is about; optional.">
        <input
          className="input mono"
          aria-label="Symbols"
          placeholder="refundPartial"
          value={symbols}
          onChange={(e) => setSymbols(e.target.value)}
        />
      </Row>
      <Row label="Keywords" desc="Words in a change that bring it up; optional.">
        <input
          className="input"
          aria-label="Keywords"
          placeholder="chargeback, captured"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
        />
      </Row>
      <Row label="Critical" desc="Always given to a change it applies to, whatever the budget.">
        <button
          type="button"
          role="switch"
          className="switch"
          aria-label="Critical"
          aria-checked={critical}
          onClick={() => setCritical(!critical)}
        />
      </Row>
      <div className="learning-body">
        <label className="label" htmlFor="learning-body">
          What a reviewer should know
        </label>
        <textarea
          id="learning-body"
          className="input mono"
          rows={8}
          maxLength={MAX_BODY}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <span className="subtle small">
          Markdown, up to {MAX_BODY.toLocaleString()} characters ({body.length} now).
        </span>
      </div>
      <div className="rule-foot">
        {save.error !== null && (
          <span className="error small grow" role="alert">
            Could not send it: {why(save.error)}.
          </span>
        )}
        <label className="check small">
          <input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} />
          Commit to {props.branch} instead of opening a pull request
        </label>
        <Button type="button" variant="outline" onClick={() => props.done(null)}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.busy || !ready}>
          {direct ? "Commit" : "Open pull request"}
        </Button>
      </div>
    </form>
  );
}
