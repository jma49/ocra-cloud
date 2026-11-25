import { type SubmitEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AUTOMATION_TRIGGERS,
  type AutomationConditionKey,
  type AutomationMatchView,
  type AutomationPullFacts,
  type AutomationSkipView,
  type AutomationTrigger,
  TRIGGER_CONDITIONS,
  type Verdict,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { listOf } from "../form.js";
import { useAction } from "../ui.js";
import {
  ACTION_LABEL,
  SKIP_LABEL,
  TRIGGER_LABEL,
  VERDICT_LABEL,
  VERDICT_LIST,
} from "./describe.js";
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
  const [quietHours, setQuietHours] = useState("");
  const [paths, setPaths] = useState("");
  const takes = (key: AutomationConditionKey) => TRIGGER_CONDITIONS[trigger].includes(key);
  const quiet = Number(quietHours);
  const [tried, setTried] = useState<Tried | null>(null);
  const pull = (): AutomationPullFacts => ({
    repoId: repoId || undefined,
    paths: listOf(paths.replaceAll("\n", ",")),
    author: takes("authors") ? author.trim() || undefined : undefined,
    baseBranch: takes("baseBranches") ? baseBranch.trim() || undefined : undefined,
    title: takes("title") ? title || undefined : undefined,
    labels: takes("labels") ? listOf(labels) : undefined,
    critical: takes("critical") ? critical : undefined,
    verdict: takes("verdicts") ? verdict || undefined : undefined,
    quietHours:
      takes("staleHours") && quietHours !== "" && Number.isInteger(quiet) && quiet >= 0
        ? quiet
        : undefined,
  });
  const run = useAction(() =>
    api<Tried>("/automations/dry-run", {
      method: "POST",
      body: JSON.stringify({ trigger, pull: pull() }),
    }),
  );
  const submit = async (e: SubmitEvent) => {
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
          <select
            className="input"
            aria-label="Moment"
            value={trigger}
            onChange={(e) => {
              setTrigger(e.target.value as AutomationTrigger);
              setTried(null);
            }}
          >
            {AUTOMATION_TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {TRIGGER_LABEL[t]}
              </option>
            ))}
          </select>
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
        {takes("staleHours") && (
          <input
            className="input"
            inputMode="numeric"
            aria-label="Hours without activity"
            placeholder="hours quiet"
            value={quietHours}
            onChange={(e) => setQuietHours(e.target.value.trim())}
          />
        )}
        {takes("authors") && (
          <input
            className="input mono"
            aria-label="Author"
            placeholder="author"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        )}
        {takes("baseBranches") && (
          <input
            className="input mono"
            aria-label="Base branch"
            placeholder="main"
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
          />
        )}
        {takes("title") && (
          <input
            className="input grow"
            aria-label="Title"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
        {takes("labels") && (
          <input
            className="input"
            aria-label={trigger === "labeled" ? "Label added" : "Labels on it"}
            placeholder={trigger === "labeled" ? "label added" : "labels, comma-separated"}
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
          />
        )}
        {takes("verdicts") && (
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
        )}
        {takes("critical") && (
          <label className="check">
            <input
              type="checkbox"
              checked={critical}
              onChange={(e) => setCritical(e.target.checked)}
            />
            Has a critical finding
          </label>
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
