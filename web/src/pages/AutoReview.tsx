import FolderGit2 from "lucide-react/icons/folder-git-2";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type AutoReviewRepoView,
  type CodePlatformKind,
  DAILY_LIMIT_WAIT,
  REPO_CONFIG_IGNORED,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { AccessToken } from "../auto-review/access-token.js";
import { type Added, AddRepo, type ListedRepos, listedOn } from "../auto-review/add-repo.js";
import { AutoEnroll } from "../auto-review/auto-enroll.js";
import { AutomaticSwitch } from "../auto-review/automatic-switch.js";
import { BulkEnroll } from "../auto-review/bulk-enroll.js";
import { Hook } from "../auto-review/hook-card.js";
import { jobError, pausedWhy } from "../auto-review/job-error.js";
import { LimitReachedNotice } from "../auto-review/limit-reached.js";
import { NoKeyNotice } from "../auto-review/no-key.js";
import { ProfileMenu } from "../auto-review/profile-menu.js";
import { RepoWebhook } from "../auto-review/repo-webhook.js";
import { RunnerStatus } from "../auto-review/runner-status.js";
import { useRead } from "../cache.js";
import { ago } from "../format.js";
import { RepoChecks } from "../merge-checks/repo-checks.js";
import { PlatformMark } from "../platform-mark.js";
import { PLATFORM_NAME } from "../platform-names.js";
import { pullPath } from "../pull/path.js";
import { ReviewTargetsCard } from "../review-targets/targets-card.js";
import { Link } from "../router.js";
import { StackTable } from "../stack-table.js";
import { ActionError, EmptyState, LoadError, Loading, PageHead, useAction } from "../ui.js";

// The repositories whose pull requests this server reviews itself when they
// open or gain commits (ADR-0046), as the ocra bot. A GitLab hook's secret is
// shown once, when the repository is added.

type Repos = { repos: AutoReviewRepoView[] };
type Job = NonNullable<AutoReviewRepoView["latest"]>;
/** What a repository's row opens under itself. */
type Panel = "checks" | "token" | "webhook";

const STATE: Record<Job["state"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "badge-run" },
  running: { label: "Reviewing", tone: "badge-run" },
  done: { label: "Reviewed", tone: "badge-ok" },
  failed: { label: "Failed", tone: "badge-err" },
  superseded: { label: "Superseded", tone: "" },
};

export function AutoReview(props: { platforms: readonly CodePlatformKind[] }) {
  const { data, error, reload } = useRead<Repos>("/auto-review/repos");
  const listed = useRead<ListedRepos>("/platforms/repos").data;
  const [added, setAdded] = useState<Added | null>(null);
  const [open, setOpen] = useState<{ id: string; panel: Panel } | null>(null);
  const shows = (id: string, panel: Panel) => open?.id === id && open.panel === panel;
  const toggle = (id: string, panel: Panel) => setOpen(shows(id, panel) ? null : { id, panel });
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
      <LimitReachedNotice />
      <NoKeyNotice />
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
      {props.platforms.includes("github") && (
        <>
          <BulkEnroll listed={listed} enrolled={data?.repos ?? []} onAdded={reload} />
          <AutoEnroll />
        </>
      )}
      {added && <Hook added={added} onDone={() => setAdded(null)} />}
      {remove.error !== null && <ActionError what="remove it" error={remove.error} />}
      {error && !data ? (
        <LoadError what="your repositories" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="repositories" />
      ) : data.repos.length === 0 ? (
        <div className="card">
          <EmptyState icon={FolderGit2} title="No repositories yet">
            Add one above. ocra reviews its pull requests when you ask, or each one as it opens once
            you switch Automatic on.
          </EmptyState>
        </div>
      ) : (
        <div className="card">
          <StackTable>
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Automatic</th>
                  <th>Profile</th>
                  <th>Last review</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
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
                          {r.accessTokenBot && ` · as ${r.accessTokenBot}`}
                        </div>
                        {r.paused && (
                          <div className="small repo-paused">
                            <span className="badge badge-warn">Paused</span>{" "}
                            <span className="subtle">{pausedWhy(r.paused)}</span>
                          </div>
                        )}
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
                          aria-expanded={shows(r.id, "checks")}
                          onClick={() => toggle(r.id, "checks")}
                        >
                          Checks
                        </Button>{" "}
                        {r.platform === "gitlab" && (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-expanded={shows(r.id, "token")}
                              onClick={() => toggle(r.id, "token")}
                            >
                              Token
                            </Button>{" "}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-expanded={shows(r.id, "webhook")}
                              onClick={() => toggle(r.id, "webhook")}
                            >
                              Webhook
                            </Button>{" "}
                          </>
                        )}
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
                    {shows(r.id, "checks") && (
                      <tr className="checks-row">
                        <td colSpan={5}>
                          <RepoChecks repoId={r.id} fullName={r.fullName} />
                        </td>
                      </tr>
                    )}
                    {shows(r.id, "token") && (
                      <tr className="checks-row">
                        <td colSpan={5}>
                          <AccessToken r={r} onChanged={reload} />
                        </td>
                      </tr>
                    )}
                    {shows(r.id, "webhook") && (
                      <tr className="checks-row">
                        <td colSpan={5}>
                          <RepoWebhook r={r} onChanged={reload} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </StackTable>
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
      ) : job.error === REPO_CONFIG_IGNORED ? (
        <span className="subtle small job-error">
          The repository's .ocra/config.json could not be read or is not valid, so this review ran
          without it.
        </span>
      ) : (
        job.error && <span className="error-inline small job-error">{jobError(job.error)}</span>
      )}
    </div>
  );
}
