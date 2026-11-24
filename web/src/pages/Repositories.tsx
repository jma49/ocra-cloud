import FolderGit2 from "lucide-react/icons/folder-git-2";
import Lock from "lucide-react/icons/lock";
import Pencil from "lucide-react/icons/pencil";
import Unplug from "lucide-react/icons/unplug";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CodePlatformKind } from "../../../src/shared/index.js";
import { api, type Me, why } from "../api.js";
import { useCached, useRead } from "../cache.js";
import { ago, count, num } from "../format.js";
import { useListCursor } from "../list-cursor.js";
import { usePageCommands } from "../page-commands.js";
import { PlatformMark } from "../platform-mark.js";
import { PLATFORM_NAME } from "../platform-names.js";
import { Link } from "../router.js";
import { PLATFORM_DOCS } from "../site.js";
import { EmptyState, LoadError, Loading, PageHead, useAction } from "../ui.js";

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
        onKeyDown={(e) => {
          if (e.key === "Escape") props.done(false);
        }}
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

function RepoName(props: {
  repo: Repo;
  known: Known | null;
  editing: boolean;
  edit: (on: boolean) => void;
  saved: () => void;
}) {
  const { repo, known } = props;
  if (props.editing)
    return (
      <NameField
        repo={repo}
        current={known?.name ?? ""}
        done={(saved) => {
          props.edit(false);
          if (saved) props.saved();
        }}
      />
    );
  const label = `${known ? "Rename" : "Name"} ${known?.name ?? repo.repo}`;
  return (
    <div className="repo-name">
      {known?.platform ? (
        <PlatformMark platform={known.platform} size={16} />
      ) : (
        <span className="repo-name-mark" aria-hidden="true" />
      )}
      <div className="repo-name-text">
        <div className={known ? "strong" : "muted"}>{known?.name ?? "Unknown repository"}</div>
        <div className="subtle small">
          {known ? (known.where ?? "Named by you") : <span className="mono">{repo.repo}</span>}
        </div>
      </div>
      <button
        type="button"
        className={`icon-btn repo-rename${known ? "" : " is-shown"}`}
        aria-label={label}
        title={label}
        onClick={() => props.edit(true)}
      >
        <Pencil size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The code platforms the console reads as the user, and how to connect one that is not. */
function PlatformsSection(props: { me: Me; data: PlatformRepos }) {
  return (
    <div className="card platforms">
      <div className="card-head">
        <h2>Connected platforms</h2>
      </div>
      {props.data.platforms.length === 0 && (
        <EmptyState
          icon={Unplug}
          title="No code platform on this server"
          action={
            <Button
              variant="outline"
              render={<a href={PLATFORM_DOCS} target="_blank" rel="noreferrer" />}
            >
              How to connect one
            </Button>
          }
        >
          Whoever runs this server connects GitHub or GitLab to it. Then its pull requests and
          repositories show up here and in the inbox.
        </EmptyState>
      )}
      {props.data.platforms.map((p) => (
        <div className="platform" key={`${p.platform}:${p.host}`}>
          <div className="list-row platform-row">
            <PlatformMark platform={p.platform} size={20} />
            <div className="grow">
              <div>
                <span className="strong">{PLATFORM_NAME[p.platform]}</span>{" "}
                <span className="subtle">{p.host}</span>
              </div>
              <PlatformState p={p} />
            </div>
            <Connect me={props.me} p={p} />
          </div>
          {p.linked && !p.failed && p.repositories.length > 0 && <PlatformRepoList p={p} />}
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

/** The repositories a platform's app may read, folded under its row: owner quiet, name in ink. */
function PlatformRepoList(props: { p: PlatformRepos["platforms"][number] }) {
  const { p } = props;
  return (
    <details className="platform-repos">
      <summary className="fold-row">
        <span className="fold" aria-hidden="true" />
        Repositories it can read
        <span className="subtle">
          {num(p.repositories.length)}
          {p.more ? "+" : ""}
        </span>
      </summary>
      <ul className="platform-repo-list">
        {p.repositories.map((r) => {
          const cut = r.fullName.lastIndexOf("/") + 1;
          return (
            <li key={r.id} className="platform-repo">
              <span className="platform-repo-name">
                <span className="subtle">{r.fullName.slice(0, cut)}</span>
                {r.fullName.slice(cut)}
              </span>
              {r.private && (
                <span className="subtle small with-mark">
                  <Lock size={12} aria-hidden="true" />
                  Private
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {p.more && (
        <p className="platform-repos-more subtle small">
          The platform listed the first {num(p.repositories.length)}.
        </p>
      )}
    </details>
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
      <p className="subtle small m-0">
        Not connected. Connect it to see your {p.platform === "gitlab" ? "merge" : "pull"} requests
        and your repositories by name.
      </p>
    );
  if (p.failed)
    return (
      <p className="error small m-0">
        {PLATFORM_NAME[p.platform]} refused to list your repositories. Reconnect to renew access.
      </p>
    );
  if (p.repositories.length === 0)
    return (
      <p className="subtle small m-0">
        The ocra Cloud app is not installed on any repository you can reach. Choose the repositories
        it may read, then reload this page.
      </p>
    );
  return (
    <p className="subtle small m-0">
      Connected · the app reads {count(p.repositories.length, "repository", "repositories")}
      {p.more ? " or more" : ""}
    </p>
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
  const platforms = useRead<PlatformRepos>("/platforms/repos");
  useSyncNames(data?.repositories, platforms.data, reload);
  const list = useRef<HTMLTableSectionElement>(null);
  const rows = data?.repositories ?? [];
  const cursor = useListCursor(rows.length, list);
  const [editing, setEditing] = useState<string | null>(null);
  const row = rows[cursor.current];
  usePageCommands(
    "These repositories",
    row
      ? [
          { label: "Next repository", key: "j", run: () => cursor.move(1) },
          { label: "Previous repository", key: "k", run: () => cursor.move(-1) },
          {
            label: row.name === null ? "Name the repository" : "Rename the repository",
            key: "e",
            run: () => {
              cursor.show();
              setEditing(row.repoHash);
            },
          },
        ]
      : [],
  );
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
        <div className="section card">
          <EmptyState
            icon={FolderGit2}
            title="No repositories yet"
            action={
              props.me.autoReview && (
                <Button variant="outline" render={<Link to="/auto-review" />}>
                  Set up auto review
                </Button>
              )
            }
          >
            A repository appears here after its first review.{" "}
            {props.me.autoReview ? "Turn on auto review for it, or sign in" : "Sign in"} with{" "}
            <span className="mono">ocra login</span> and run{" "}
            <span className="mono">ocra review</span>.
          </EmptyState>
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
              <tbody ref={list}>
                {data.repositories.map((r, i) => (
                  <tr
                    key={r.repoHash}
                    data-row={i}
                    className={cursor.shown && i === cursor.current ? "is-current" : undefined}
                  >
                    <td className="text">
                      <RepoName
                        repo={r}
                        known={knownAs(r, platforms.data?.platforms ?? [])}
                        editing={editing === r.repoHash}
                        edit={(on) => setEditing(on ? r.repoHash : null)}
                        saved={reload}
                      />
                    </td>
                    <td className="num">{num(r.reviews)}</td>
                    <td className="num">{num(r.findings)}</td>
                    <td className="num">{num(r.openFindings)}</td>
                    <td className="muted hide-narrow">
                      {r.lastReviewAt ? ago(r.lastReviewAt) : "Never"}
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
