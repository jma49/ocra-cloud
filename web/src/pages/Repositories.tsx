import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CodePlatformKind } from "../../../src/shared/index.js";
import { api, type Me, why } from "../api.js";
import { useCached } from "../cache.js";
import { ago, count, num } from "../format.js";
import { PlatformMark } from "../platform-mark.js";
import { LoadError, Loading, PageHead, useAction, useLoad } from "../ui.js";

// The repositories the account's reviews came from, by name: the one the
// account gave, else the platform's name for its hash, else the path a pull
// request review named. The hash shows only for a repository none of them know.

type Repo = {
  repoHash: string;
  repo: string;
  name: string | null;
  pulledFrom: { host: string; repo: string } | null;
  reviews: number;
  findings: number;
  openFindings: number;
  lastReviewAt: string | null;
};

type PlatformRepos = {
  sharing: boolean;
  platforms: {
    platform: CodePlatformKind;
    host: string;
    linked: boolean;
    failed: boolean;
    /** Where the user chooses the repositories the platform's app reaches. */
    installUrl: string | null;
    more: boolean;
    repositories: { id: string; fullName: string; private: boolean; repoHash: string | null }[];
  }[];
};

const PLATFORM_NAME: Record<CodePlatformKind, string> = { github: "GitHub", gitlab: "GitLab" };

type Known = { name: string; platform: CodePlatformKind | null; where: string | null };

/** What the page knows a repository as, and on which platform; null when only its hash is known. */
function knownAs(r: Repo, platforms: PlatformRepos["platforms"]): Known | null {
  const listed = platforms.flatMap((p) =>
    p.repositories.filter((x) => x.repoHash === r.repoHash).map((x) => ({ p, x })),
  )[0];
  const pulledOn = r.pulledFrom && platforms.find((p) => p.host === r.pulledFrom?.host);
  const where = listed
    ? `${PLATFORM_NAME[listed.p.platform]} · ${listed.p.host}`
    : r.pulledFrom
      ? pulledOn
        ? `${PLATFORM_NAME[pulledOn.platform]} · ${r.pulledFrom.host}`
        : r.pulledFrom.host
      : null;
  const name = r.name ?? listed?.x.fullName ?? r.pulledFrom?.repo;
  const platform = listed?.p.platform ?? pulledOn?.platform ?? null;
  return name ? { name, platform, where } : null;
}

function NameField(props: { repo: Repo; current: string; done: (saved: boolean) => void }) {
  const [draft, setDraft] = useState(props.repo.name ?? props.current);
  const path = `/repositories/${props.repo.repoHash}`;
  const save = useAction(() =>
    draft.trim()
      ? api(path, { method: "PUT", body: JSON.stringify({ name: draft.trim() }) })
      : api(path, { method: "DELETE" }),
  );
  return (
    <form
      className="name-field"
      onSubmit={async (e) => {
        e.preventDefault();
        if ((await save.run()) !== undefined) props.done(true);
      }}
    >
      <input
        type="text"
        className="input"
        aria-label={`Name of ${props.current || props.repo.repo}`}
        placeholder="owner/name"
        maxLength={200}
        value={draft}
        // biome-ignore lint/a11y/noAutofocus: the field opens on the user's click.
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
      />
      <Button type="submit" variant="outline" size="sm" disabled={save.busy}>
        {draft.trim() ? "Save" : "Clear"}
      </Button>
      <Button variant="outline" size="sm" onClick={() => props.done(false)}>
        Cancel
      </Button>
      {save.error ? (
        <span className="error small" role="alert">
          {why(save.error)}
        </span>
      ) : null}
    </form>
  );
}

function RepoName(props: { repo: Repo; known: Known | null; saved: () => void }) {
  const [editing, setEditing] = useState(false);
  const { repo, known } = props;
  if (editing)
    return (
      <NameField
        repo={repo}
        current={known?.name ?? ""}
        done={(saved) => {
          setEditing(false);
          if (saved) props.saved();
        }}
      />
    );
  return (
    <div className="repo-name">
      <div>
        <div className={known ? "mono strong with-mark" : "muted"}>
          {known?.platform && <PlatformMark platform={known.platform} size={14} />}
          {known?.name ?? "Unknown repository"}
        </div>
        <div className="subtle small">
          {known?.where ? `${known.where} · ` : ""}
          <span className="mono">{repo.repo}</span>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        aria-label={`${known ? "Rename" : "Name"} ${known?.name ?? repo.repo}`}
        onClick={() => setEditing(true)}
      >
        {known ? "Rename" : "Name it"}
      </Button>
    </div>
  );
}

/** The code platforms the console reads as the user, and how to connect one that is not. */
function PlatformsSection(props: { me: Me; data: PlatformRepos }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>Connected platforms</h3>
      </div>
      {props.data.platforms.map((p) => (
        <div className="list-row row-top" key={`${p.platform}:${p.host}`}>
          <div className="grow">
            <div className="strong">
              {PLATFORM_NAME[p.platform]} <span className="muted small mono">{p.host}</span>
            </div>
            <PlatformState p={p} />
          </div>
          <Connect me={props.me} p={p} />
        </div>
      ))}
      {!props.data.sharing && props.data.platforms.some((p) => p.repositories.length > 0) && (
        <div className="list-row">
          <p className="muted small m-0">
            Turn on findings sharing in Settings, and reviews you run locally are matched to these
            repositories by name too.
          </p>
        </div>
      )}
    </div>
  );
}

function Connect(props: { me: Me; p: PlatformRepos["platforms"][number] }) {
  const { p } = props;
  if (p.linked && !p.failed)
    return p.installUrl ? (
      <Button
        variant="outline"
        size="sm"
        render={<a href={p.installUrl} target="_blank" rel="noopener noreferrer" />}
      >
        Choose repositories
      </Button>
    ) : null;
  if (p.platform === "gitlab")
    return (
      <Button variant="outline" size="sm" render={<a href="/api/platforms/gitlab/connect" />}>
        Connect GitLab
      </Button>
    );
  // GitHub's access comes with signing in with GitHub; doing it again renews it in place.
  if (props.me.githubId === null) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      render={<a href={`/api/auth/github/login?next=${encodeURIComponent("/repositories")}`} />}
    >
      {p.linked ? "Reconnect GitHub" : "Connect GitHub"}
    </Button>
  );
}

function PlatformState(props: { p: PlatformRepos["platforms"][number] }) {
  const { p } = props;
  if (!p.linked)
    return (
      <p className="muted small">
        Not connected yet. Connect it to see your {p.platform === "gitlab" ? "merge" : "pull"}{" "}
        requests and your repositories by name.
      </p>
    );
  if (p.failed)
    return (
      <p className="error small">
        {PLATFORM_NAME[p.platform]} refused to list your repositories. Reconnect to renew access.
      </p>
    );
  if (p.repositories.length === 0)
    return (
      <p className="muted small">
        The ocra Cloud app is not installed on any repository you can reach. Choose the repositories
        it may read, then reload this page.
      </p>
    );
  return (
    <details className="small">
      <summary className="muted">
        {count(p.repositories.length, "repository", "repositories")}
        {p.more ? " (the first ones)" : ""}
      </summary>
      <ul className="mono repo-list">
        {p.repositories.map((r) => (
          <li key={r.id}>
            {r.fullName}
            {r.private ? " (private)" : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Stores the platform's names for reviewed repositories that have none, once, so every page shows them. */
function useSyncNames(
  repos: Repo[] | undefined,
  platforms: PlatformRepos | undefined,
  done: () => void,
) {
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current || !repos || !platforms?.sharing) return;
    const listed = new Set(
      platforms.platforms.flatMap((p) => p.repositories.map((r) => r.repoHash)),
    );
    if (!repos.some((r) => r.name === null && listed.has(r.repoHash))) return;
    tried.current = true;
    api("/platforms/sync-names", { method: "POST" }).then(done, () => {});
  }, [repos, platforms, done]);
}

export function Repositories(props: { me: Me }) {
  const { data, error, reload } = useCached("/repositories", () =>
    api<{ repositories: Repo[] }>("/repositories"),
  );
  const platforms = useLoad(() => api<PlatformRepos>("/platforms/repos"));
  useSyncNames(data?.repositories, platforms.data, reload);
  return (
    <>
      <PageHead
        title="Repositories"
        sub="Every repository your reviews came from in the last 90 days, by its name on your code platform."
      />
      {platforms.error && !platforms.data ? (
        <LoadError
          what="your connected platforms"
          error={platforms.error}
          retry={platforms.reload}
        />
      ) : !platforms.data ? (
        <Loading what="your connected platforms" />
      ) : (
        <PlatformsSection me={props.me} data={platforms.data} />
      )}
      {error && !data ? (
        <LoadError what="repositories" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="repositories" />
      ) : data.repositories.length === 0 ? (
        <div className="section card empty-hero">
          <h3>No repositories yet</h3>
          <p>
            Run a signed-in review (ocra login, then ocra review) and its repository appears here.
          </p>
        </div>
      ) : (
        <div className="section card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th className="num">Reviews</th>
                  <th className="num">Findings</th>
                  <th className="num">Open</th>
                  <th className="hide-narrow">Last review</th>
                </tr>
              </thead>
              <tbody>
                {data.repositories.map((r) => (
                  <tr key={r.repoHash}>
                    <td className="text">
                      <RepoName
                        key={r.name ?? ""}
                        repo={r}
                        known={knownAs(r, platforms.data?.platforms ?? [])}
                        saved={reload}
                      />
                    </td>
                    <td className="num">{num(r.reviews)}</td>
                    <td className="num">{num(r.findings)}</td>
                    <td className="num">{num(r.openFindings)}</td>
                    <td className="muted hide-narrow">
                      {r.lastReviewAt ? ago(r.lastReviewAt) : "none"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
