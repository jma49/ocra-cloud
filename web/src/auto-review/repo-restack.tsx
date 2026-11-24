import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type {
  AutoReviewRepoView,
  AutoReviewRestackView,
  RestackHistoryView,
  RestackJobView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useRead } from "../cache.js";
import { ago } from "../format.js";
import { ActionError, EmptyNote, LoadError, Loading, useAction, usePoll } from "../ui.js";

// A repository's restacks: once the pull request below one merges, the
// server rebases the ones stacked on it and force-pushes them as the ocra
// bot. Off until the repository turns it on, since it rewrites branches.

/** How often the open panel reads its history: a merge elsewhere queues a job at any moment. */
const WATCH_MS = 15_000;
/** And while a job is queued or running, whose end is near. */
const ACTIVE_MS = 4_000;

const SKIPPED: Record<string, string> = {
  switched_off: "Restacking was switched off before it ran",
  stack_merge: "A stack merge holds this pull request",
  up_to_date: "The branch already holds its new base",
  push_refused: "The platform refused the bot's push",
};

/** How a restack stands, in a badge, and what it left to do, in words. */
function standing(job: RestackJobView): { label: string; tone: string; note?: string | null } {
  if (job.state === "queued") return { label: "Queued", tone: "badge badge-run" };
  if (job.state === "running") return { label: "Rebasing", tone: "badge badge-run" };
  if (job.state === "failed") return { label: "Failed", tone: "badge badge-err", note: job.reason };
  switch (job.outcome) {
    case "restacked":
      return { label: "Restacked", tone: "badge badge-ok" };
    case "conflict":
      return {
        label: "Conflict",
        tone: "badge badge-warn",
        note: "Nothing was pushed; its author restacks it locally",
      };
    case "lease_lost":
      return {
        label: "Left alone",
        tone: "badge",
        note: "The branch moved while it was rebased",
      };
    default:
      return {
        label: "Skipped",
        tone: "badge",
        note: (job.reason && SKIPPED[job.reason]) ?? job.reason,
      };
  }
}

function Job(props: { job: RestackJobView }) {
  const { job } = props;
  const { label, tone, note } = standing(job);
  return (
    <li className="list-row restack-job">
      <div className="grow">
        <div>
          <span className="mono">#{job.number}</span> onto <span className="mono">{job.onto}</span>
          <span className="subtle">
            {job.askedBy ? ` asked by ${job.askedBy}` : ` after #${job.parent} merged`}
          </span>
        </div>
        <div className="subtle small">
          <span className="mono">{job.branch}</span>
          <span className="mono"> {job.from.slice(0, 7)}</span>
          {job.to && <span className="mono"> → {job.to.slice(0, 7)}</span>}
          {note && ` · ${note}`}
        </div>
      </div>
      <span className={tone}>{label}</span>
      <span className="subtle small nobreak">{ago(job.finishedAt ?? job.createdAt)}</span>
    </li>
  );
}

export function RepoRestack(props: { r: AutoReviewRepoView; onChanged: () => void }) {
  const { r } = props;
  const base = `/auto-review/repos/${encodeURIComponent(r.id)}`;
  const history = useRead<RestackHistoryView>(`${base}/restacks`);
  const [on, setOn] = useState(r.restack);
  const save = useAction((next: boolean) =>
    api<AutoReviewRestackView>(`${base}/restack`, {
      method: "PUT",
      body: JSON.stringify({ restack: next }),
    }),
  );
  const change = async (next: boolean) => {
    setOn(next);
    const saved = await save.run(next);
    setOn(saved ? saved.restack : !next);
    if (saved) props.onChanged();
  };
  const jobs = history.data?.jobs;
  const active = jobs?.some((j) => j.state === "queued" || j.state === "running") === true;
  usePoll(true, history.reload, active ? ACTIVE_MS : WATCH_MS);
  return (
    <section className="repo-token stack" aria-label={`Restacking in ${r.fullName}`}>
      <div className="strong">Restack after a merge</div>
      <div className="with-mark restack-switch">
        <Switch
          aria-label={`Restack pull requests in ${r.fullName} after a merge`}
          checked={on}
          disabled={save.busy}
          onCheckedChange={change}
        />
        <span>
          After a stacked pull request merges, rebase the ones above it and force-push them
        </span>
      </div>
      <p className="muted small m-0">
        This rewrites contributors' branches as the ocra bot. A push holds only while the branch is
        where ocra found it, and a rebase that conflicts pushes nothing.
      </p>
      {save.error !== null && <ActionError what="change it" error={save.error} />}
      {history.error && !jobs ? (
        <LoadError what="its restacks" error={history.error} retry={history.reload} inCard />
      ) : !jobs ? (
        <Loading what="restacks" rows={2} inCard />
      ) : jobs.length === 0 ? (
        <EmptyNote>{on ? "No restacks yet." : "No restacks: it is switched off."}</EmptyNote>
      ) : (
        <ul className="restack-jobs" aria-label="Recent restacks">
          {jobs.map((job) => (
            <Job key={job.id} job={job} />
          ))}
        </ul>
      )}
    </section>
  );
}
