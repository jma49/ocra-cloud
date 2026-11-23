import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  AutomationMatchView,
  AutomationPullFacts,
  AutomationSkipView,
  AutomationTrigger,
  Verdict,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { listOf } from "../form.js";
import { Seg, useAction } from "../ui.js";
import { ACTION_LABEL, SKIP_LABEL, VERDICT_LABEL, VERDICT_LIST } from "./describe.js";
import type { Choice } from "./rule-form.js";

// Describe a pull request and see which enabled rules would act on it;
// nothing is done.

type Tried = { matches: AutomationMatchView[]; skipped: AutomationSkipView[] };

export function DryRun(props: { queued: boolean; repos: Choice[] | null }) {
  const [trigger, setTrigger] = useState<AutomationTrigger>(props.queued ? "queued" : "reviewed");
  const [repoId, setRepoId] = useState("");
  const [author, setAuthor] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [title, setTitle] = useState("");
  const [labels, setLabels] = useState("");
  const [critical, setCritical] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | "">("");
  const [paths, setPaths] = useState("");
  const [tried, setTried] = useState<Tried | null>(null);
  const pull = (): AutomationPullFacts => ({
    repoId: repoId || undefined,
    paths: listOf(paths.replaceAll("\n", ",")),
    ...(trigger === "queued"
      ? {
          author: author.trim() || undefined,
          baseBranch: baseBranch.trim() || undefined,
          title: title || undefined,
          labels: listOf(labels),
        }
      : { critical, verdict: verdict || undefined }),
  });
  const run = useAction(() =>
    api<Tried>("/automations/dry-run", {
      method: "POST",
      body: JSON.stringify({ trigger, pull: pull() }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run.run();
    if (r) setTried(r);
  };
  return (
    <form className="card card-pad stack section" onSubmit={submit} aria-label="Try the rules">
      <h2 className="card-title">Try the rules</h2>
      <p className="subtle small m-0">
        Describe a pull request and see which rules would act on it. Nothing is done.
      </p>
      <div className="add-fields">
        {props.queued && (
          <Seg
            label="Moment"
            value={trigger}
            onChange={(t) => {
              setTrigger(t);
              setTried(null);
            }}
            options={[
              { value: "queued", label: "Queued" },
              { value: "reviewed", label: "Reviewed" },
            ]}
          />
        )}
        {props.repos && props.repos.length > 0 && (
          <select
            className="input"
            aria-label="Repository"
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
          >
            <option value="">Any repository</option>
            {props.repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        )}
        {trigger === "queued" ? (
          <>
            <input
              className="input mono"
              aria-label="Author"
              placeholder="author"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            />
            <input
              className="input mono"
              aria-label="Base branch"
              placeholder="main"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
            />
            <input
              className="input grow"
              aria-label="Title"
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              className="input"
              aria-label="Labels on it"
              placeholder="labels, comma-separated"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
            />
          </>
        ) : (
          <>
            <select
              className="input"
              aria-label="Verdict"
              value={verdict}
              onChange={(e) => setVerdict(e.target.value as Verdict | "")}
            >
              <option value="">No verdict</option>
              {VERDICT_LIST.map((v) => (
                <option key={v} value={v}>
                  {VERDICT_LABEL[v]}
                </option>
              ))}
            </select>
            <label className="check">
              <input
                type="checkbox"
                checked={critical}
                onChange={(e) => setCritical(e.target.checked)}
              />
              Has a critical finding
            </label>
          </>
        )}
        <input
          className="input mono grow"
          aria-label="Changed files"
          placeholder="changed files: src/payments/refund.ts, db/001.sql"
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={run.busy}>
          Try
        </Button>
      </div>
      {run.error !== null && (
        <p className="error" role="alert">
          Could not try it: {why(run.error)}.
        </p>
      )}
      {tried && (
        <div role="status">
          {tried.matches.length === 0 && tried.skipped.length === 0 ? (
            <p className="muted small m-0">No enabled rule would act on it.</p>
          ) : (
            <ul className="dry-matches">
              {tried.matches.map((m) => (
                <li key={m.ruleId}>
                  <span className="strong">{m.name}</span>{" "}
                  <span className="muted">
                    would {m.actions.map((k) => ACTION_LABEL[k].toLowerCase()).join(", ")}
                  </span>
                </li>
              ))}
              {tried.skipped.map((m) => (
                <li key={m.ruleId}>
                  <span className="strong">{m.name}</span>{" "}
                  <span className="muted">
                    not decided:{" "}
                    {m.reason === "paths_unavailable"
                      ? "list the changed files to try it"
                      : SKIP_LABEL[m.reason].toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
