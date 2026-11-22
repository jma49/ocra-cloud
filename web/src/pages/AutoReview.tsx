import { type FormEvent, Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type AutoReviewRepoView,
  CODE_PLATFORMS,
  type CodePlatformKind,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { ProfileMenu } from "../auto-review/profile-menu.js";
import { ago } from "../format.js";
import { RepoChecks } from "../merge-checks/repo-checks.js";
import { PlatformMark } from "../platform-mark.js";
import { pullPath } from "../pull/path.js";
import { Link } from "../router.js";
import { ActionError, LoadError, Loading, PageHead, useAction, useLoad } from "../ui.js";

// The repositories whose pull requests this server reviews itself when they
// open or gain commits (ADR-0046), as the ocra bot. A GitLab hook's secret is
// shown once, when the repository is added.

type Repos = { repos: AutoReviewRepoView[] };
type Added = { repo: AutoReviewRepoView; webhook: { url: string; secret?: string } };
type Job = NonNullable<AutoReviewRepoView["latest"]>;

const PLATFORM: Record<CodePlatformKind, string> = { github: "GitHub", gitlab: "GitLab" };
const STATE: Record<Job["state"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "badge-run" },
  running: { label: "Reviewing", tone: "badge-run" },
  done: { label: "Reviewed", tone: "badge-ok" },
  failed: { label: "Failed", tone: "badge-err" },
  superseded: { label: "Superseded", tone: "" },
};

export function AutoReview() {
  const { data, error, reload } = useLoad(() => api<Repos>("/auto-review/repos"));
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
        sub="Pull requests in these repositories are reviewed by this server when they open or gain commits, and the review is posted as the ocra bot."
      />
      <AddRepo
        full={(data?.repos.length ?? 0) >= 100}
        onAdded={(a) => {
          setAdded(a);
          reload();
        }}
      />
      {added && <Hook added={added} onDone={() => setAdded(null)} />}
      {remove.error !== null && <ActionError what="stop reviewing it" error={remove.error} />}
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
                          {PLATFORM[r.platform]} · {r.host}
                        </div>
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
                          Stop reviewing
                        </Button>
                      </td>
                    </tr>
                    {checking === r.id && (
                      <tr className="checks-row">
                        <td colSpan={4}>
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
    </>
  );
}

function LastJob(props: { r: AutoReviewRepoView }) {
  const { r } = props;
  const job = r.latest;
  if (!job) return <span className="subtle">No pull request yet</span>;
  const state = STATE[job.state];
  return (
    <div className="stack-tight">
      <span>
        <Link to={pullPath(r.platform, r.fullName, job.number)}>#{job.number}</Link>{" "}
        <span className={`badge ${state.tone}`}>{state.label}</span>{" "}
        {job.finishedAt && <span className="subtle small">{ago(job.finishedAt)}</span>}
      </span>
      {job.error && <span className="error-inline small job-error">{job.error}</span>}
    </div>
  );
}

function Hook(props: { added: Added; onDone: () => void }) {
  const { repo, webhook } = props.added;
  return (
    <section className="card card-pad stack hook-card" aria-label="Webhook">
      <div className="strong">One step on {PLATFORM[repo.platform]}</div>
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

function AddRepo(props: { full: boolean; onAdded: (a: Added) => void }) {
  const [platform, setPlatform] = useState<CodePlatformKind>("github");
  const [fullName, setFullName] = useState("");
  const add = useAction(() =>
    api<Added>("/auto-review/repos", {
      method: "POST",
      body: JSON.stringify({ platform, fullName: fullName.trim() }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const a = await add.run();
    if (!a) return;
    setFullName("");
    props.onAdded(a);
  };
  return (
    <form className="card card-pad stack add-form" onSubmit={submit}>
      <div className="strong">Add a repository</div>
      <div className="add-fields">
        <select
          className="input"
          aria-label="Platform"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as CodePlatformKind)}
        >
          {CODE_PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM[p]}
            </option>
          ))}
        </select>
        <input
          className="input grow mono"
          aria-label="Repository"
          placeholder={platform === "gitlab" ? "group/project" : "owner/repo"}
          maxLength={400}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
        />
        <Button type="submit" disabled={add.busy || props.full || !fullName.trim()}>
          Add
        </Button>
      </div>
      {props.full && (
        <span className="subtle small">An account reviews at most 100 repositories.</span>
      )}
      {add.error !== null && (
        <p className="error" role="alert">
          Could not add it: {why(add.error)}.
        </p>
      )}
    </form>
  );
}
