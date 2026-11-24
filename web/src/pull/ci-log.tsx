import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PullCiExplainView, PullCiJob, PullCiLogView } from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { Drawer } from "../drawer.js";
import { Markdown } from "../markdown.js";
import { useAction, useLoad } from "../ui.js";

// A failed CI job's last lines, read now as the user, and on request the
// account's model's short reading of why it failed. Nothing is kept.

type Pull = { platform: string; repo: string; number: number };

const SOURCE: Record<PullCiLogView["source"], string> = {
  job_log: "The end of the job's log.",
  check_output: "What the check reported of itself.",
  none: "The platform gave no log for this job; open it there.",
};

const explainError = (e: unknown) =>
  e instanceof ApiError && e.code === "no_key"
    ? "Add a model key in Settings to have ocra explain failures."
    : e instanceof ApiError && e.code === "daily_limit"
      ? "Today's model calls are used up. Try again tomorrow."
      : `Could not explain it: ${why(e)}.`;

function Explain(props: { pull: Pull; job: string }) {
  const [answer, setAnswer] = useState<PullCiExplainView | null>(null);
  const ask = useAction(async () => {
    const got = await api<PullCiExplainView>("/pulls/ci/explain", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, job: props.job }),
    });
    setAnswer(got);
  });
  if (answer?.explanation) {
    return (
      <section className="ci-explain stack-tight" aria-label="Why it failed">
        <Markdown text={answer.explanation} />
        <span className="subtle small">
          {`From ${answer.model ?? "the account's model"}, reading the log below. Check it before acting on it.`}
        </span>
      </section>
    );
  }
  return (
    <div className="stack-tight ci-explain-ask">
      <Button variant="outline" size="sm" loading={ask.busy} onClick={ask.run}>
        Explain the failure
      </Button>
      {answer && !answer.explanation && (
        <span className="subtle small" role="status">
          There is no log to explain.
        </span>
      )}
      {ask.error !== null && (
        <p className="error small m-0" role="alert">
          {explainError(ask.error)}
        </p>
      )}
    </div>
  );
}

export function CiLogDrawer(props: { pull: Pull; job: PullCiJob; onClose: () => void }) {
  const { pull, job } = props;
  const id = job.id ?? "";
  const q = new URLSearchParams({ ...pull, number: String(pull.number), job: id }).toString();
  const log = useLoad(() => api<PullCiLogView>(`/pulls/ci/log?${q}`), [q]);
  return (
    <Drawer
      title={`Log of ${job.name}`}
      heading={job.name}
      onClose={props.onClose}
      foot={
        job.url ? (
          <a className="status-link" href={job.url} target="_blank" rel="noreferrer">
            Open on the platform
          </a>
        ) : undefined
      }
    >
      <div className="stack">
        {job.failedStep && <span className="subtle small">{`Failed at ${job.failedStep}.`}</span>}
        {log.data?.source !== "none" && <Explain pull={pull} job={id} />}
        {log.loading && <p className="muted small m-0">Reading the log…</p>}
        {log.error !== null && !log.data && (
          <p className="error small m-0" role="alert">
            {`Could not read the log: ${why(log.error)}.`}
          </p>
        )}
        {log.data && (
          <>
            <span className="subtle small">
              {SOURCE[log.data.source]}
              {log.data.redacted && " Values that look like secrets are hidden."}
            </span>
            {log.data.log && (
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region takes focus so the keyboard can scroll it
              <pre className="ci-log" tabIndex={0}>
                {log.data.log}
              </pre>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
