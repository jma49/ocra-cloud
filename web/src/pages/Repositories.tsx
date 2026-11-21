import { useState } from "react";
import { api, why } from "../api.js";
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

export function Repositories() {
  const { data, error, reload } = useLoad(() => api<{ repositories: Repo[] }>("/repositories"));
  return (
    <>
      <PageHead
        title="Repositories"
        sub="Every repository your reviews came from in the last 90 days. Reviews send only an anonymous hash; name the ones you recognise and the console shows the name instead."
      />
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
