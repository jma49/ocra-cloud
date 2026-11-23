import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type AutoReviewRepoView,
  type CodePlatformKind,
  DAILY_LIMIT_WAIT,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { type Added, AddRepo, type ListedRepos, listedOn } from "../auto-review/add-repo.js";
import { AutomaticSwitch } from "../auto-review/automatic-switch.js";
import { DailyLimitNotice } from "../auto-review/daily-limit.js";
import { ProfileMenu } from "../auto-review/profile-menu.js";
import { RunnerStatus } from "../auto-review/runner-status.js";
import { ago } from "../format.js";
import { RepoChecks } from "../merge-checks/repo-checks.js";
import { PlatformMark } from "../platform-mark.js";
import { PLATFORM_NAME } from "../platform-names.js";
import { pullPath } from "../pull/path.js";
import { ReviewTargetsCard } from "../review-targets/targets-card.js";
import { Link } from "../router.js";
import { ActionError, LoadError, Loading, PageHead, useAction, useLoad } from "../ui.js";

// The repositories whose pull requests this server reviews itself when they
// open or gain commits (ADR-0046), as the ocra bot. A GitLab hook's secret is
// shown once, when the repository is added.

type Repos = { repos: AutoReviewRepoView[] };
type Job = NonNullable<AutoReviewRepoView["latest"]>;

const STATE: Record<Job["state"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "badge-run" },
  running: { label: "Reviewing", tone: "badge-run" },
  done: { label: "Reviewed", tone: "badge-ok" },
  failed: { label: "Failed", tone: "badge-err" },
  superseded: { label: "Superseded", tone: "" },
};

export function AutoReview(props: { platforms: readonly CodePlatformKind[] }) {
  const { data, error, reload } = useLoad(() => api<Repos>("/auto-review/repos"));
  const listed = useLoad(() => api<ListedRepos>("/platforms/repos")).data;
  const [added, setAdded] = useState<Added | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const remove = useAction((id: string) =>
    api(`/auto-review/repos/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
  const drop = async (id: string) => {
    if ((await remove.run(id)) === undefined) return;
    if (added?.repo.id === id) setAdded(null);
    reload();
  };
  return (
    <>
      <PageHead
        title="Auto review"
        sub="This server reviews pull requests in these repositories as the ocra bot: any one when you ask on its page, and each one as it opens or gains commits once you switch Automatic on, which starts off. Their findings are kept here, to read on each pull request; Settings, Account & privacy turns that off."
      />
      <RunnerStatus />
      <DailyLimitNotice />
      <AddRepo
        platforms={props.platforms}
        full={(data?.repos.length ?? 0) >= 100}
        listed={listed}
        enrolled={data?.repos ?? []}
        onAdded={(a) => {
          // The App already sends this repository's events: nothing is left to do on GitHub.
          setAdded(a.repo.platform === "github" && listedOn(listed, a.repo) ? null : a);
          reload();
        }}
      />
      {added && <Hook added={added} onDone={() => setAdded(null)} />}
      {remove.error !== null && <ActionError what="remove it" error={remove.error} />}
      {error && !data ? (
        <LoadError what="your repositories" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="repositories" />
      ) : data.repos.length === 0 ? (
        <p className="subtle small">No repositories yet.</p>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Automatic</th>
                  <th>Profile</th>
                  <th>Last review</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.repos.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td className="text">
                        <div className="mono with-mark">
                          <PlatformMark platform={r.platform} size={14} />
                          {r.fullName}
                        </div>
                        <div className="subtle small">
                          {PLATFORM_NAME[r.platform]} · {r.host}
                        </div>
                      </td>
                      <td>
                        <AutomaticSwitch r={r} />
                      </td>
                      <td>
                        <ProfileMenu r={r} />
                      </td>
                      <td>
                        <LastJob r={r} />
                      </td>
                      <td className="num nobreak">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-expanded={checking === r.id}
                          onClick={() => setChecking(checking === r.id ? null : r.id)}
                        >
                          Checks
                        </Button>{" "}
                        <Button
                          type="button"
                          variant="destructive-outline"
                          size="sm"
                          disabled={remove.busy}
                          onClick={() => drop(r.id)}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                    {checking === r.id && (
                      <tr className="checks-row">
                        <td colSpan={5}>
                          <RepoChecks repoId={r.id} fullName={r.fullName} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ReviewTargetsCard />
    </>
  );
}

function LastJob(props: { r: AutoReviewRepoView }) {
  const { r } = props;
  const job = r.latest;
  if (!job) return <span className="subtle">No review since it was added</span>;
  const state = STATE[job.state];
  return (
    <div className="stack-tight">
      <span>
        <Link to={pullPath(r.platform, r.fullName, job.number)}>#{job.number}</Link>{" "}
        <span className={`badge ${state.tone}`}>{state.label}</span>{" "}
        {job.finishedAt && <span className="subtle small">{ago(job.finishedAt)}</span>}
      </span>
      {job.state === "queued" && job.error === DAILY_LIMIT_WAIT ? (
        <span className="subtle small job-error">
          The daily limit cut this review short. It runs again when the limit resets.
        </span>
      ) : (
        job.error && <span className="error-inline small job-error">{job.error}</span>
      )}
    </div>
  );
}

function Hook(props: { added: Added; onDone: () => void }) {
  const { repo, webhook } = props.added;
  return (
    <section className="card card-pad stack hook-card" aria-label="Webhook">
      <div className="strong">One step on {PLATFORM_NAME[repo.platform]}</div>
      {repo.platform === "gitlab" ? (
        <p className="m-0">
          In <span className="mono">{repo.fullName}</span>, open Settings, Webhooks, and add this
          address with the secret token below. Turn on Merge request events and Comments. The secret
          is shown only now.
        </p>
      ) : (
        <p className="m-0">
          Install this server's GitHub App on <span className="mono">{repo.fullName}</span>. The
          App's webhook sends pull request events to this address.
        </p>
      )}
      <label className="stack-tight">
        <span className="subtle small">Address</span>
        <input className="input mono" readOnly value={webhook.url} aria-label="Webhook address" />
      </label>
      {webhook.secret && (
        <label className="stack-tight">
          <span className="subtle small">Secret token</span>
          <input className="input mono" readOnly value={webhook.secret} aria-label="Secret token" />
        </label>
      )}
      <div>
        <Button type="button" variant="outline" onClick={props.onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}
