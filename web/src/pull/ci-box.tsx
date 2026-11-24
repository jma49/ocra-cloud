import CircleCheck from "lucide-react/icons/circle-check";
import CircleDashed from "lucide-react/icons/circle-dashed";
import CircleMinus from "lucide-react/icons/circle-minus";
import CircleX from "lucide-react/icons/circle-x";
import RotateCw from "lucide-react/icons/rotate-cw";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CiJobState,
  CiRerunOutcome,
  MendCheckView,
  PullCiJob,
  PullCiRerunAnswer,
  PullCiView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { count, elapsed } from "../format.js";
import { useAction, useLoad, usePoll } from "../ui.js";
import { CiLogDrawer } from "./ci-log.js";
import { Tally } from "./tally.js";

// The pull request's CI on its head, read live from the platform: failed
// jobs first with their failed step and what the fix loop made of them,
// the rest folded, and the two things a person does next (read why a job
// failed, run the failed ones again).

const RUNNING_MS = 20_000;

type Pull = { platform: string; repo: string; number: number };

const MARK: Record<CiJobState, { icon: typeof CircleCheck; cls: string; label: string }> = {
  passed: { icon: CircleCheck, cls: "ok", label: "Passed" },
  failed: { icon: CircleX, cls: "err", label: "Failed" },
  pending: { icon: CircleDashed, cls: "wait", label: "Running" },
  cancelled: { icon: CircleMinus, cls: "wait", label: "Cancelled" },
  skipped: { icon: CircleMinus, cls: "wait", label: "Skipped" },
  neutral: { icon: CircleMinus, cls: "wait", label: "Neutral" },
};

const MEND: Record<MendCheckView["outcome"], string> = {
  fixed: "ocra committed a fix for it",
  proposed: "ocra proposed a fix for it",
  rejected: "ocra's fix did not pass its check; it may try again",
  deferred: "ocra has not worked on it yet",
  needs_human: "ocra left it to a person",
  gone: "it no longer fails at this head",
};

const RERUN: Record<Exclude<CiRerunOutcome, "rerun">, string> = {
  stale: "The branch moved since this page read it; nothing was run.",
  nothing_failed: "Nothing failed to run again.",
  not_rerunnable: "These jobs are not ones ocra can run again; open them on the platform.",
  refused: "",
};

const refusedText = (platform: string) =>
  platform === "github"
    ? "GitHub refused: the ocra GitHub App needs the Actions write permission on this repository to run jobs again."
    : "GitLab refused: your account may not run this project's jobs.";

function JobMark(props: { state: CiJobState }) {
  const m = MARK[props.state];
  const Icon = m.icon;
  return (
    <span className={`check-mark ${m.cls}`} role="img" aria-label={m.label}>
      <Icon size={14} aria-hidden="true" />
    </span>
  );
}

const took = (j: PullCiJob) =>
  j.durationSeconds === null ? null : elapsed(j.durationSeconds * 1000);

function Job(props: { job: PullCiJob; onOpen?: (() => void) | undefined }) {
  const { job } = props;
  const detail = [job.failedStep ?? job.failureReason?.replaceAll("_", " "), took(job)].filter(
    Boolean,
  );
  return (
    <li>
      <JobMark state={job.state} />
      <div className="ci-job">
        <div className="row-gap ci-job-head">
          {job.url ? (
            <a className="grow ci-job-name" href={job.url} target="_blank" rel="noreferrer">
              {job.name}
            </a>
          ) : (
            <span className="grow ci-job-name">{job.name}</span>
          )}
          {props.onOpen && (
            <Button variant="ghost" size="xs" onClick={props.onOpen}>
              Log
            </Button>
          )}
        </div>
        {detail.length > 0 && <div className="subtle small">{detail.join(" · ")}</div>}
        {job.mend && <div className="subtle small">{`${MEND[job.mend.outcome]}.`}</div>}
      </div>
    </li>
  );
}

export function CiBox(props: { pull: Pull; head: string }) {
  const q = new URLSearchParams({ ...props.pull, number: String(props.pull.number) }).toString();
  const { data, reload } = useLoad(() => api<PullCiView>(`/pulls/ci?${q}`), [q, props.head]);
  const [open, setOpen] = useState<PullCiJob | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const jobs = data?.jobs ?? [];
  const failed = jobs.filter((j) => j.state === "failed");
  const running = jobs.filter((j) => j.state === "pending");
  const rest = jobs.filter((j) => j.state !== "failed");
  usePoll(running.length > 0, reload, RUNNING_MS);
  const rerun = useAction(async () => {
    const answer = await api<PullCiRerunAnswer>("/pulls/ci/rerun", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, head: data?.head ?? props.head }),
    });
    setSaid(
      answer.outcome === "rerun"
        ? `${count(answer.rerun, "run")} started again.`
        : answer.outcome === "refused"
          ? refusedText(props.pull.platform)
          : RERUN[answer.outcome],
    );
    reload();
  });
  if (!data || jobs.length === 0) return null;
  const passed = jobs.filter((j) => j.state === "passed").length;
  const standing =
    failed.length > 0
      ? { text: `${failed.length} failed`, tone: "badge badge-err" }
      : running.length > 0
        ? { text: "Running", tone: "badge" }
        : { text: "Passing", tone: "badge badge-ok" };
  const other = rest.length - passed - running.length;
  const others = [
    passed > 0 && `${passed} passed`,
    running.length > 0 && `${running.length} running`,
    other > 0 && `${other} other`,
  ].filter(Boolean);
  return (
    <section className="card card-pad stack ci-box" aria-label="CI">
      <div className="row-gap checks-head">
        <h2 className="card-title grow">CI</h2>
        <span className={standing.tone}>{standing.text}</span>
      </div>
      <Tally
        label={`${passed} of ${jobs.length} passed`}
        parts={[
          { tone: "ok", n: passed },
          { tone: "err", n: failed.length },
          { tone: "wait", n: jobs.length - passed - failed.length },
        ]}
      />
      {failed.length > 0 && (
        <ul className="check-results">
          {failed.map((j) => (
            <Job
              key={j.id ?? j.name}
              job={j}
              onOpen={j.id && j.hasLog ? () => setOpen(j) : undefined}
            />
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <details className="ci-rest" open={failed.length === 0 && running.length > 0}>
          <summary className="subtle small">
            <span className="fold" aria-hidden="true" />
            {others.join(", ")}
          </summary>
          <ul className="check-results">
            {rest.map((j) => (
              <Job key={j.id ?? j.name} job={j} />
            ))}
          </ul>
        </details>
      )}
      {failed.some((j) => j.rerunnable) && (
        <Button variant="outline" size="sm" loading={rerun.busy} onClick={rerun.run}>
          <RotateCw size={14} aria-hidden="true" />
          Rerun failed
        </Button>
      )}
      {rerun.error !== null && (
        <p className="error small m-0" role="alert">
          {`Could not run them again: ${why(rerun.error)}.`}
        </p>
      )}
      {said && (
        <span className="subtle small" role="status">
          {said}
        </span>
      )}
      {data.more && <span className="subtle small">The platform listed more jobs than these.</span>}
      {open && <CiLogDrawer pull={props.pull} job={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
