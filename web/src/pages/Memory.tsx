import Brain from "lucide-react/icons/brain";
import { Button } from "@/components/ui/button";
import { api, why } from "../api.js";
import { useRead } from "../cache.js";
import { ago } from "../format.js";
import { Link } from "../router.js";
import { EmptyState, LoadError, Loading, PageHead, useAction } from "../ui.js";

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
  const {
    data,
    error: loadError,
    reload,
  } = useRead<{ entries: Entry[]; total?: number }>("/memory");
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
        <div className="card">
          <EmptyState
            icon={Brain}
            title="Nothing remembered yet"
            action={
              <Button variant="outline" render={<Link to="/reviews" />}>
                Open reviews
              </Button>
            }
          >
            Open a review with findings and choose Remember on one. A repository's own
            .ocra/memory.json keeps working too.
          </EmptyState>
        </div>
      ) : (
        <div className="card">
          {(data.total ?? 0) > data.entries.length && (
            <p className="muted small">
              Showing the newest {data.entries.length} of {data.total}. Forget some to see the older
              ones; reviews apply them all.
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Finding</th>
                  <th>Reason</th>
                  <th>Added</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((m) => (
                  <tr key={m.id}>
                    <td>{m.repo}</td>
                    <td className="finding-cell">
                      <div>{m.title ?? <span className="subtle">(title removed)</span>}</div>
                      <div className="mono subtle small">{m.file ?? m.fingerprint}</div>
                    </td>
                    <td className="text">{m.reason}</td>
                    <td className="muted">{ago(m.createdAt)}</td>
                    <td className="num">
                      <Button
                        type="button"
                        variant="destructive-outline"
                        size="sm"
                        onClick={() => remove(m.id)}
                      >
                        Forget
                      </Button>
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
