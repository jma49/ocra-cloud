import { api, why } from "../api.js";
import { ago } from "../format.js";
import { LoadError, Loading, PageHead, useAction, useLoad } from "../ui.js";

// What the account remembers (ADR-0028, 4): applied with a repository's own
// .ocra/memory.json, which wins on a conflict.

type Entry = {
  id: string;
  repo: string;
  fingerprint: string;
  file: string | null;
  title: string | null;
  reason: string;
  createdAt: string;
};

export function Memory() {
  const { data, error: loadError, reload } = useLoad(() => api<{ entries: Entry[] }>("/memory"));
  const forget = useAction((id: string) => api(`/memory/${id}`, { method: "DELETE" }));
  const remove = async (id: string) => {
    if ((await forget.run(id)) !== undefined) reload();
  };
  const failed = forget.error ? `Could not forget it: ${why(forget.error)}.` : "";
  return (
    <>
      <PageHead
        title="Memory"
        sub="Findings your team accepts: signed-in reviews of the same repository stop reporting them, and each report says what memory hid."
      />
      {failed && (
        <p className="error" role="alert">
          {failed}
        </p>
      )}
      {loadError && !data ? (
        <LoadError what="memory" error={loadError} retry={reload} />
      ) : !data ? (
        <Loading what="memory" />
      ) : data.entries.length === 0 ? (
        <div className="card empty-hero">
          <h3>Nothing remembered yet</h3>
          <p>
            Open a review with findings and choose Remember on one. A repository's own
            .ocra/memory.json keeps working too.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Finding</th>
                  <th>Reason</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.entries.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.repo}</td>
                    <td className="finding-cell">
                      <div>{m.title ?? <span className="subtle">(title removed)</span>}</div>
                      <div className="mono subtle small">{m.file ?? m.fingerprint}</div>
                    </td>
                    <td className="text">{m.reason}</td>
                    <td className="muted">{ago(m.createdAt)}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => remove(m.id)}
                      >
                        Forget
                      </button>
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
