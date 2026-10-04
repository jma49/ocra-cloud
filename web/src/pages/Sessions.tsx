import { useState } from "react";
import { ago, api, date, type Session, why } from "../api.js";
import { LoadError, Loading, PageHead, useLoad } from "../ui.js";

export function Sessions() {
  const [data, loadError, reload] = useLoad(() => api<{ sessions: Session[] }>("/sessions"));
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  const revoke = async (s: Session) => {
    setBusy(s.id);
    setFailed("");
    try {
      await api(`/sessions/${s.id}`, { method: "DELETE" });
    } catch (e) {
      setBusy(null);
      setFailed(`Could not ${s.current ? "sign out" : "revoke the session"}: ${why(e)}.`);
      return;
    }
    setBusy(null);
    if (s.current) location.href = "/";
    else reload();
  };
  return (
    <>
      <PageHead title="CLI & sessions" sub="Browsers and terminals signed in to your account." />
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 500 }}>Sign in from the terminal</div>
        <div className="muted small" style={{ marginTop: 4 }}>
          <span className="cmd">ocra login</span> opens this site to approve the terminal, then
          reviews use your keys through ocra Cloud.
        </div>
      </div>
      {failed && (
        <p className="error" role="alert">
          {failed}
        </p>
      )}
      {loadError && !data ? (
        <LoadError what="your sessions" error={loadError} retry={reload} />
      ) : !data ? (
        <Loading what="sessions" />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Name</th>
                  <th>Signed in</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="badge">{s.kind === "web" ? "Browser" : "CLI"}</span>
                    </td>
                    <td>
                      {s.label ?? (s.kind === "web" ? "Web session" : "Terminal")}{" "}
                      {s.current && <span className="badge badge-ok">this session</span>}
                    </td>
                    <td className="muted">{date(s.createdAt)}</td>
                    <td className="muted">{ago(s.lastUsedAt)}</td>
                    <td className="muted">{date(s.expiresAt)}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busy === s.id}
                        onClick={() => revoke(s)}
                      >
                        {s.current ? "Sign out" : "Revoke"}
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
