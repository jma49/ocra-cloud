import { useState } from "react";
import { ago, api, date, type Session } from "../api.js";
import { PageHead, useLoad } from "../ui.js";

export function Sessions() {
  const [data, , reload] = useLoad(() => api<{ sessions: Session[] }>("/sessions"));
  const [busy, setBusy] = useState<string | null>(null);
  const revoke = async (s: Session) => {
    setBusy(s.id);
    await api(`/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
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
          reviews use your keys through ocra Cloud. <span className="badge">coming soon</span>
        </div>
      </div>
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
              {(data?.sessions ?? []).map((s) => (
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
    </>
  );
}
