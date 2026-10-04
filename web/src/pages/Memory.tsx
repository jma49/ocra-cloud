import { ago, api } from "../api.js";
import { PageHead, useLoad } from "../ui.js";

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
  const [data, , reload] = useLoad(() => api<{ entries: Entry[] }>("/memory"));
  const remove = async (id: string) => {
    await api(`/memory/${id}`, { method: "DELETE" }).catch(() => {});
    reload();
  };
  return (
    <>
      <PageHead
        title="Memory"
        sub="Findings your team accepts: signed-in reviews of the same repository stop reporting them, and each report says what memory hid."
      />
      {data && data.entries.length === 0 ? (
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
                {(data?.entries ?? []).map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.repo}</td>
                    <td style={{ whiteSpace: "normal", minWidth: 220 }}>
                      <div>{m.title ?? <span className="subtle">(title removed)</span>}</div>
                      <div className="mono subtle small">{m.file ?? m.fingerprint}</div>
                    </td>
                    <td style={{ whiteSpace: "normal" }}>{m.reason}</td>
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
