import { useState } from "react";
import type { CodePlatformKind } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useCached } from "../cache.js";
import { ago, num } from "../format.js";
import { LoadError, Loading, PageHead, useAction, useLoad } from "../ui.js";

// The repositories the account's reviews came from. Uploads carry only a
// hash of the repository; a name given here is shown wherever the hash is.

type Repo = {
  repoHash: string;
  repo: string;
  name: string | null;
  reviews: number;
  findings: number;
  openFindings: number;
  lastReviewAt: string | null;
};

function NameField(props: { repo: Repo; saved: () => void }) {
  const [draft, setDraft] = useState(props.repo.name ?? "");
  const path = `/repositories/${props.repo.repoHash}`;
  const save = useAction(() =>
    draft.trim()
      ? api(path, { method: "PUT", body: JSON.stringify({ name: draft.trim() }) })
      : api(path, { method: "DELETE" }),
  );
  const changed = draft.trim() !== (props.repo.name ?? "");
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if ((await save.run()) !== undefined) props.saved();
      }}
    >
      <input
        type="text"
        aria-label={`Name of ${props.repo.repo}`}
        placeholder="owner/name"
        maxLength={200}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="btn btn-sm" disabled={!changed || save.busy}>
        {draft.trim() ? "Save" : "Clear"}
      </button>
      {save.error ? (
        <span className="error small" role="alert">
          {why(save.error)}
        </span>
      ) : null}
    </form>
  );
}

type PlatformRepos = {
  sharing: boolean;
  platforms: {
    platform: CodePlatformKind;
    host: string;
    linked: boolean;
    failed: boolean;
    more: boolean;
    repositories: { id: string; fullName: string; private: boolean; repoHash: string | null }[];
  }[];
};

const PLATFORM_NAME: Record<CodePlatformKind, string> = { github: "GitHub", gitlab: "GitLab" };

/** The repositories the user reaches on each connected code platform, read live. */
function PlatformsSection(props: { synced: () => void }) {
  const { data, error, reload } = useLoad(() => api<PlatformRepos>("/platforms/repos"));
  const sync = useAction(() =>
    api<{ named: number; sharing: boolean }>("/platforms/sync-names", { method: "POST" }),
  );
  const [done, setDone] = useState("");
  if (error && !data)
    return <LoadError what="your connected repositories" error={error} retry={reload} />;
  if (!data) return <Loading what="your connected repositories" />;
  const anyRepos = data.platforms.some((p) => p.repositories.length > 0);
  return (
    <div className="card">
      <h3>Connected platforms</h3>
      {data.platforms.map((p) => (
        <section key={`${p.platform}:${p.host}`}>
          <h4>
            {PLATFORM_NAME[p.platform]} <span className="muted small mono">{p.host}</span>
          </h4>
          {!p.linked ? (
            <p>Sign out and sign in again to let ocra Cloud read your repositories here.</p>
          ) : p.failed ? (
            <p className="error">{PLATFORM_NAME[p.platform]} refused to list your repositories.</p>
          ) : p.repositories.length === 0 ? (
            <p>
              The ocra Cloud app is not installed on any repository you can reach. Install it on the
              repositories you want here.
            </p>
          ) : (
            <>
              <p className="muted">
                {p.repositories.length} repositories{p.more ? " (the first ones)" : ""}.
              </p>
              <ul className="small mono">
                {p.repositories.map((r) => (
                  <li key={r.id}>
                    {r.fullName}
                    {r.private ? " (private)" : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
      {anyRepos &&
        (data.sharing ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={sync.busy}
            onClick={async () => {
              const answer = await sync.run();
              if (answer) {
                setDone(`${answer.named} repositories named.`);
                props.synced();
              }
            }}
          >
            Name repositories from these platforms
          </button>
        ) : (
          <p className="muted small">
            Turn on findings sharing in Settings to match reviews to these repositories: only then
            does the CLI hash a repository the same way on every machine.
          </p>
        ))}
      {done && <p className="muted small">{done}</p>}
      {sync.error ? (
        <p className="error" role="alert">
          Could not name them: {why(sync.error)}.
        </p>
      ) : null}
    </div>
  );
}

export function Repositories() {
  const { data, error, reload } = useCached("/repositories", () =>
    api<{ repositories: Repo[] }>("/repositories"),
  );
  return (
    <>
      <PageHead
        title="Repositories"
        sub="Every repository your reviews came from in the last 90 days. Reviews send only an anonymous hash; name the ones you recognise and the console shows the name instead."
      />
      <PlatformsSection synced={reload} />
      {error && !data ? (
        <LoadError what="repositories" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="repositories" />
      ) : data.repositories.length === 0 ? (
        <div className="card empty-hero">
          <h3>No repositories yet</h3>
          <p>
            Run a signed-in review (ocra login, then ocra review) and its repository appears here.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Hash</th>
                  <th>Name</th>
                  <th className="num">Reviews</th>
                  <th className="num">Findings</th>
                  <th className="num">Open</th>
                  <th>Last review</th>
                </tr>
              </thead>
              <tbody>
                {data.repositories.map((r) => (
                  <tr key={r.repoHash}>
                    <td className="mono">{r.repo}</td>
                    <td>
                      <NameField key={r.name ?? ""} repo={r} saved={reload} />
                    </td>
                    <td className="num">{num(r.reviews)}</td>
                    <td className="num">{num(r.findings)}</td>
                    <td className="num">{num(r.openFindings)}</td>
                    <td className="muted">{r.lastReviewAt ? ago(r.lastReviewAt) : "none"}</td>
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
