import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  AutomationMatchView,
  AutomationPullFacts,
  AutomationTrigger,
  Verdict,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { listOf } from "../form.js";
import { Seg, useAction } from "../ui.js";
import { ACTION_LABEL, VERDICT_LABEL, VERDICT_LIST } from "./describe.js";
import type { Choice } from "./rule-form.js";

// Describe a pull request and see which enabled rules would act on it;
// nothing is done.

export function DryRun(props: { queued: boolean; repos: Choice[] | null }) {
  const [trigger, setTrigger] = useState<AutomationTrigger>(props.queued ? "queued" : "reviewed");
  const [repoId, setRepoId] = useState("");
  const [author, setAuthor] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [title, setTitle] = useState("");
  const [labels, setLabels] = useState("");
  const [critical, setCritical] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | "">("");
  const [matches, setMatches] = useState<AutomationMatchView[] | null>(null);
  const pull = (): AutomationPullFacts => ({
    repoId: repoId || undefined,
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
    api<{ matches: AutomationMatchView[] }>("/automations/dry-run", {
      method: "POST",
      body: JSON.stringify({ trigger, pull: pull() }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run.run();
    if (r) setMatches(r.matches);
  };
  return (
    <form className="card card-pad stack section" onSubmit={submit} aria-label="Try the rules">
      <div className="strong">Try the rules</div>
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
              setMatches(null);
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
        <Button type="submit" variant="outline" disabled={run.busy}>
          Try
        </Button>
      </div>
      {run.error !== null && (
        <p className="error" role="alert">
          Could not try it: {why(run.error)}.
        </p>
      )}
      {matches && (
        <div role="status">
          {matches.length === 0 ? (
            <p className="muted small m-0">No enabled rule would act on it.</p>
          ) : (
            <ul className="dry-matches">
              {matches.map((m) => (
                <li key={m.ruleId}>
                  <span className="strong">{m.name}</span>{" "}
                  <span className="muted">
                    would {m.actions.map((k) => ACTION_LABEL[k].toLowerCase()).join(", ")}
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
