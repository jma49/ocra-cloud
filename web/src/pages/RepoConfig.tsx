import FileJson from "lucide-react/icons/file-json";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  HOSTED_CONFIG_KEYS,
  HOSTED_REVIEWER_KEYS,
  type RepoConfigChangeView,
  type RepoConfigFile,
  type RepoConfigIssue,
  type RepoConfigView,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { useRead } from "../cache.js";
import { ago } from "../format.js";
import { ChangeOutcome } from "../learnings/outcome.js";
import { type RepoChoice, useRepoChoice } from "../repo-choice.js";
import { LoadError, Loading, PageHead, Seg, useAction } from "../ui.js";

// A repository's committed review configuration, read live from its default
// branch as the user and edited as JSON. A change is checked by the server
// against the engine's schema first, then committed by the user: on a new
// branch opened as a pull request unless they ask otherwise.

const FILES: { value: RepoConfigFile; label: string }[] = [
  { value: "config", label: "Config" },
  { value: "rules", label: "Rules" },
];

export function RepoConfig() {
  const choice = useRepoChoice("/review-config");
  const [file, setFile] = useState<RepoConfigFile>("config");
  return (
    <>
      <PageHead
        title="Review config"
        sub="How reviews of a repository run, from .ocra on its default branch. A change you make here is checked first, then committed as you and opened as a pull request."
        actions={
          <>
            <Seg label="File" value={file} onChange={setFile} options={FILES} />
            {choice.select}
          </>
        }
      />
      {choice.body(FileJson, (repo, key) => (
        <FileEditor key={`${key}:${file}`} at={repo} file={file} />
      ))}
    </>
  );
}

function FileEditor(props: { at: RepoChoice; file: RepoConfigFile }) {
  const query = new URLSearchParams({ ...props.at, file: props.file }).toString();
  const { data, error, reload } = useRead<RepoConfigView>(`/repo-config?${query}`);
  if (error && !data) return <LoadError what="the file" error={error} retry={reload} />;
  if (!data) return <Loading what="the file" />;
  // A reload after a change reads a new blob: the editor starts again from it.
  return <Editor key={data.blobId ?? data.commit} view={data} at={props.at} reload={reload} />;
}

const starter = (view: RepoConfigView) =>
  view.schema ? `${JSON.stringify({ $schema: view.schema }, null, 2)}\n` : "{}\n";

/** Why the text is not JSON, or null when it is. */
function notJson(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "it is not JSON";
  }
}

const at = (path: (string | number)[]) => (path.length === 0 ? "the file" : path.join("."));

function Issues(props: { issues: readonly RepoConfigIssue[]; more: boolean }) {
  if (props.issues.length === 0) return null;
  return (
    <ul className="config-issues" aria-label="What a review would refuse">
      {props.issues.map((i) => (
        <li key={`${i.path.join(".")}:${i.message}`}>
          <span className="mono">{at(i.path)}</span> {i.message}
        </li>
      ))}
      {props.more && <li className="subtle">And more: fix these first.</li>}
    </ul>
  );
}

/** The same issues as the CLI prints them, for someone who will fix the file in a terminal. */
function Refusal(props: { text: string | null | undefined }) {
  if (!props.text) return null;
  return (
    <details>
      <summary className="config-refusal-head">As the ocra CLI says it</summary>
      <pre className="config-refusal-text">{props.text}</pre>
    </details>
  );
}

const HOSTED_KEYS = HOSTED_CONFIG_KEYS.flatMap((key) =>
  key === "reviewers"
    ? HOSTED_REVIEWER_KEYS.map((k) => `reviewers.<id>.${k}`)
    : key === "github"
      ? ["github.requestChanges"]
      : [key],
);

/** The CLI reads the whole file; a review this server runs takes only part of it, under the account's settings. */
function HostedNote(props: { branch: string }) {
  return (
    <details>
      <summary className="config-refusal-head">What hosted reviews take from this file</summary>
      <ul className="config-hosted small">
        <li>
          A review this server runs reads the file on {props.branch} and applies only{" "}
          {HOSTED_KEYS.map((k, i) => (
            <span key={k}>
              {i > 0 && (i === HOSTED_KEYS.length - 1 ? " and " : ", ")}
              <code className="mono">{k}</code>
            </span>
          ))}
          . The ocra CLI reads every key.
        </li>
        <li>
          Where the account's settings or the repository's review profile set the same thing, they
          win. The spend limit is the lower of the file's and the account's.
        </li>
        <li>
          <code className="mono">minInlineSeverity</code>,{" "}
          <code className="mono">maxInlineComments</code> and <code className="mono">ultra</code>{" "}
          can only hold a review tighter than its depth and the account: a higher floor, fewer
          inline comments, ultra off. A looser value is not used.
        </li>
        <li>
          <code className="mono">exclude</code> here replaces the account's excludes, even when it
          is empty, and a reviewer's entry replaces the account's entry for that reviewer.
        </li>
      </ul>
    </details>
  );
}

function Editor(props: { view: RepoConfigView; at: RepoChoice; reload: () => void }) {
  const { view } = props;
  const [text, setText] = useState(view.text ?? starter(view));
  const [direct, setDirect] = useState(false);
  const [change, setChange] = useState<RepoConfigChangeView | null>(null);
  const save = useAction(() =>
    api<RepoConfigChangeView>("/repo-config", {
      method: "POST",
      body: JSON.stringify({
        ...props.at,
        file: view.file,
        text,
        expected: view.blobId,
        direct,
      }),
    }),
  );
  const broken = notJson(text);
  const edited = text !== (view.text ?? "");
  // The server names an issue by its path into the request: `text`, then the path in the file.
  const refusal = save.error instanceof ApiError ? save.error : null;
  const refused = (refusal?.issues ?? []).map((i) => ({
    path: i.path.slice(1),
    message: i.message,
  }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const done = await save.run();
    if (!done) return;
    setChange(done);
    if (done.outcome === "done" && !done.pull) props.reload();
  };
  return (
    <>
      {change && <ChangeOutcome change={change} branch={view.branch} />}
      <form className="card section" aria-label={view.path} onSubmit={submit}>
        <div className="card-head">
          <h2>
            <span className="mono">{view.path}</span>{" "}
            <span className="muted">
              on {view.branch}
              {view.blobId === null
                ? " · not there yet"
                : view.lastCommit?.at
                  ? ` · changed ${ago(view.lastCommit.at)}`
                  : ""}
            </span>
          </h2>
          {change?.outcome === "conflict" && (
            <Button type="button" variant="outline" size="sm" onClick={props.reload}>
              Read it again
            </Button>
          )}
        </div>
        <div className="config-editor">
          {view.parseError && (
            <p className="error small m-0" role="status">
              The file on {view.branch} is not read by reviews: {view.parseError}.
            </p>
          )}
          {view.file === "config" && <HostedNote branch={view.branch} />}
          {!edited && (
            <>
              <Issues issues={view.errors} more={view.moreErrors} />
              <Refusal text={view.refusal} />
            </>
          )}
          <textarea
            className="input mono"
            aria-label={`Contents of ${view.path}`}
            spellCheck={false}
            rows={Math.min(32, Math.max(12, text.split("\n").length + 1))}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {broken && edited && (
            <p className="error small m-0" role="status">
              Not JSON yet: {broken}.
            </p>
          )}
          {edited && (
            <>
              <Issues issues={refused} more={refusal?.file.more ?? false} />
              <Refusal text={refusal?.file.refusal} />
            </>
          )}
          {save.error !== null && refused.length === 0 && (
            <p className="error small m-0" role="alert">
              Could not send it: {why(save.error)}.
            </p>
          )}
        </div>
        <div className="list-row config-foot">
          <label className="check small grow">
            <input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} />
            Commit to {view.branch} instead of opening a pull request
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={!edited}
            onClick={() => setText(view.text ?? starter(view))}
          >
            Discard
          </Button>
          <Button type="submit" disabled={!edited || broken !== null} loading={save.busy}>
            {direct ? "Commit" : "Open pull request"}
          </Button>
        </div>
      </form>
    </>
  );
}
