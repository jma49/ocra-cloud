import Network from "lucide-react/icons/network";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { CodePlatformKind, GraphPolicy, GraphRepoView } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useCached } from "../cache.js";
import { ago, bytes, num } from "../format.js";
import { PLATFORM_NAME, PlatformSelect } from "../platform-names.js";
import { StackTable } from "../stack-table.js";
import { useToast } from "../toast.js";
import {
  ActionError,
  EmptyState,
  LoadError,
  Loading,
  PageHead,
  useAction,
  usePoll,
} from "../ui.js";

type Repos = { repos: GraphRepoView[] };
type Added = { repo: GraphRepoView; webhook: { url: string; secret?: string } };
type Rebuilt = { queued: boolean; repo: GraphRepoView };

const POLL_MS = 4000;

// The runner's failure codes (src/graph/runner.ts), in words.
const FAILURES: Record<string, string> = {
  repo_gone: "The repository was removed.",
  platform_gone: "This server no longer connects to that platform.",
  unlinked: "Your account is no longer connected to the platform; sign in again.",
  no_bot: "ocra's app is not installed on the repository, so it cannot be cloned.",
  tree_unreadable: "The platform did not return the commit's files.",
  clone_failed: "The repository could not be cloned.",
  too_large: "The graph is larger than this server keeps.",
  build_failed: "The graph could not be built, or not within its time limit.",
};
const failure = (code: string) => FAILURES[code] ?? "The build failed.";

const building = (r: GraphRepoView) =>
  r.latest?.state === "queued" || r.latest?.state === "running";

export function CodeGraphs(props: { policy: GraphPolicy; platforms: readonly CodePlatformKind[] }) {
  return (
    <>
      <PageHead
        title="Code graphs"
        sub="A map of each repository's symbols and where they are used, kept for its default branch and updated on every push. Reviews read it to follow a change to its callers. Names and line numbers only, never code."
      />
      {props.policy === "off" ? (
        <div className="section card">
          <EmptyState icon={Network} title="This server keeps no code graphs">
            Its administrator turned them off (CODE_GRAPH=off). Reviews still run, reading only the
            changed files.
          </EmptyState>
        </div>
      ) : (
        <GraphRepos policy={props.policy} platforms={props.platforms} />
      )}
    </>
  );
}

function GraphRepos(props: {
  policy: Exclude<GraphPolicy, "off">;
  platforms: readonly CodePlatformKind[];
}) {
  const { data, error, reload, change } = useCached("/graphs/repos", () =>
    api<Repos>("/graphs/repos"),
  );
  const [webhook, setWebhook] = useState<Added["webhook"] | null>(null);
  const active = data?.repos.some(building) ?? false;
  usePoll(active, reload, POLL_MS);

  const put = (repo: GraphRepoView) =>
    change((d) => ({
      repos: d.repos.some((r) => r.id === repo.id)
        ? d.repos.map((r) => (r.id === repo.id ? repo : r))
        : [...d.repos, repo],
    }));

  return (
    <>
      <AddRepo
        platforms={props.platforms}
        policy={props.policy}
        added={(answer) => {
          put(answer.repo);
          setWebhook(answer.webhook);
        }}
      />
      {webhook && <WebhookNote webhook={webhook} close={() => setWebhook(null)} />}
      {error && !data ? (
        <LoadError what="your code graphs" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="code graphs" />
      ) : data.repos.length === 0 ? (
        <div className="section card">
          <EmptyState icon={Network} title="No code graphs yet">
            Add a repository above. Its first graph builds from the default branch's head.
          </EmptyState>
        </div>
      ) : (
        <div className="section card">
          <StackTable>
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Status</th>
                  <th>Commit</th>
                  <th className="num">Files</th>
                  <th className="num">Size</th>
                  <th>Last build</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.repos.map((r) => (
                  <GraphRow key={r.id} repo={r} put={put} change={change} />
                ))}
              </tbody>
            </table>
          </StackTable>
        </div>
      )}
    </>
  );
}

function AddRepo(props: {
  policy: Exclude<GraphPolicy, "off">;
  platforms: readonly CodePlatformKind[];
  added: (a: Added) => void;
}) {
  const [platform, setPlatform] = useState<CodePlatformKind>(props.platforms[0] ?? "github");
  const [fullName, setFullName] = useState("");
  const [consent, setConsent] = useState(false);
  const add = useAction(() =>
    api<Added>("/graphs/repos", {
      method: "POST",
      body: JSON.stringify({
        platform,
        fullName: fullName.trim(),
        ...(props.policy === "opt-in" ? { consent } : {}),
      }),
    }),
  );
  const ready = fullName.trim() !== "" && (props.policy === "keep" || consent);
  return (
    <form
      className="card card-pad graph-add"
      onSubmit={async (e) => {
        e.preventDefault();
        const answer = await add.run();
        if (!answer) return;
        props.added(answer);
        setFullName("");
        setConsent(false);
      }}
    >
      <PlatformSelect platforms={props.platforms} value={platform} onChange={setPlatform} />
      <input
        type="text"
        className="input grow"
        aria-label="Repository"
        placeholder={platform === "github" ? "owner/repository" : "group/project"}
        maxLength={400}
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={!ready || add.busy}>
        {add.busy ? "Adding…" : "Add repository"}
      </Button>
      {props.policy === "opt-in" && (
        <label className="small graph-consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{" "}
          I own this repository and agree that the server keeps its code graph.
        </label>
      )}
      {add.error ? <ActionError what="add the repository" error={add.error} /> : null}
    </form>
  );
}

function WebhookNote(props: { webhook: Added["webhook"]; close: () => void }) {
  const { url, secret } = props.webhook;
  return (
    <div className="section card card-pad" role="status">
      <div className="strong">
        {secret ? "Add this webhook to the GitLab project" : "Graph queued"}
      </div>
      <p className="muted small">
        {secret
          ? "Under Settings, Webhooks, for push events. The secret token is shown only now."
          : "The ocra Cloud app's webhook sends GitHub pushes here; no setup is needed."}
      </p>
      {secret && (
        <dl className="graph-hook mono small">
          <dt>URL</dt>
          <dd>{url}</dd>
          <dt>Secret token</dt>
          <dd>{secret}</dd>
        </dl>
      )}
      <Button type="button" variant="outline" size="sm" onClick={props.close}>
        Done
      </Button>
    </div>
  );
}

type Change = (edit: (d: Repos) => Repos) => () => void;

function GraphRow(props: { repo: GraphRepoView; put: (r: GraphRepoView) => void; change: Change }) {
  const { repo } = props;
  const toast = useToast();
  const [confirm, setConfirm] = useState<"" | "purge" | "remove">("");
  const rebuild = useAction(() =>
    api<Rebuilt>(`/graphs/repos/${repo.id}/builds`, { method: "POST" }),
  );
  const purge = useAction(() =>
    api<{ removed: number }>(`/graphs/repos/${repo.id}/graphs`, { method: "DELETE" }),
  );
  const remove = useAction(() => api(`/graphs/repos/${repo.id}`, { method: "DELETE" }));
  const busy = rebuild.busy || purge.busy || remove.busy;
  const failed = rebuild.error ?? purge.error ?? remove.error;

  const optimistic = async (edit: (d: Repos) => Repos, run: () => Promise<unknown>) => {
    setConfirm("");
    const undo = props.change(edit);
    if ((await run()) === undefined) undo();
  };
  const onRebuild = async () => {
    const answer = await rebuild.run();
    if (!answer) return;
    props.put(answer.repo);
    if (!answer.queued) toast("A build of the newest commit is already on its way.");
  };
  const onPurge = () =>
    optimistic(
      (d) => ({ repos: d.repos.map((r) => (r.id === repo.id ? { ...r, latest: null } : r)) }),
      purge.run,
    );
  const onRemove = () =>
    optimistic((d) => ({ repos: d.repos.filter((r) => r.id !== repo.id) }), remove.run);

  const latest = repo.latest;
  return (
    <tr>
      <td>
        <div className="strong mono">{repo.fullName}</div>
        <div className="subtle small">
          {PLATFORM_NAME[repo.platform]} · {repo.host} · {repo.branch}
        </div>
      </td>
      <td>
        <BuildState repo={repo} />
        {failed ? (
          <div className="error small" role="alert">
            {why(failed)}
          </div>
        ) : null}
      </td>
      <td className="mono">{latest ? latest.commit.slice(0, 7) : "–"}</td>
      <td className="num">
        <span className="cell-name" aria-hidden="true">
          Files
        </span>
        {latest?.files != null ? num(latest.files) : "–"}
      </td>
      <td className="num">
        <span className="cell-name" aria-hidden="true">
          Size
        </span>
        {latest?.bytes != null ? bytes(latest.bytes) : "–"}
      </td>
      <td className="muted">{latest?.finishedAt ? ago(latest.finishedAt) : "–"}</td>
      <td>
        <div className="row-actions">
          {confirm ? (
            <>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={confirm === "purge" ? onPurge : onRemove}
              >
                {confirm === "purge" ? "Delete graphs" : "Stop keeping"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirm("")}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || building(repo)}
                onClick={onRebuild}
              >
                {rebuild.busy ? "Queuing…" : "Rebuild"}
              </Button>
              <Button
                type="button"
                variant="destructive-outline"
                size="sm"
                disabled={busy || !latest || building(repo)}
                onClick={() => setConfirm("purge")}
              >
                Purge
              </Button>
              <Button
                type="button"
                variant="destructive-outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirm("remove")}
              >
                Remove
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function BuildState(props: { repo: GraphRepoView }) {
  const latest = props.repo.latest;
  if (!latest) return <span className="badge">No graph</span>;
  switch (latest.state) {
    case "done":
      return latest.truncated ? (
        <span className="badge badge-warn" title="The platform listed only part of the repository">
          <span className="dot" />
          Partial
        </span>
      ) : (
        <span className="badge badge-ok">
          <span className="dot" />
          Built
        </span>
      );
    case "running":
      return (
        <span className="badge badge-warn">
          <span className="dot" />
          Building
        </span>
      );
    case "queued":
      return (
        <span className="badge" title={latest.error ? failure(latest.error) : undefined}>
          <span className="dot" />
          {latest.error ? "Retrying" : "Queued"}
        </span>
      );
    case "failed":
      return (
        <>
          <span className="badge badge-err">
            <span className="dot" />
            Failed
          </span>
          {latest.error && <div className="subtle small">{failure(latest.error)}</div>}
        </>
      );
    case "superseded":
      return <span className="badge">Superseded</span>;
  }
}
