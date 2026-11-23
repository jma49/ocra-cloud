import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, type Session, why } from "../api.js";
import { useRead } from "../cache.js";
import { ago, date } from "../format.js";
import { StackTable } from "../stack-table.js";
import { LoadError, Loading, PageHead, useAction } from "../ui.js";

export function Sessions() {
  const { data, error: loadError, reload } = useRead<{ sessions: Session[] }>("/sessions");
  const [target, setTarget] = useState<Session | null>(null);
  const end = useAction((s: Session) => api(`/sessions/${s.id}`, { method: "DELETE" }));
  const revoke = async (s: Session) => {
    setTarget(s);
    if ((await end.run(s)) === undefined) return;
    if (s.current) location.href = "/";
    else reload();
  };
  const busy = end.busy ? target?.id : null;
  const failed =
    end.error && target
      ? `Could not ${target.current ? "sign out" : "revoke the session"}: ${why(end.error)}.`
      : "";
  return (
    <>
      <PageHead title="CLI & sessions" sub="Browsers and terminals signed in to your account." />
      <div className="card card-pad login-card">
        <h2 className="card-title">Sign in from the terminal</h2>
        <div className="muted small login-sub">
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
          <StackTable>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Name</th>
                  <th className="hide-narrow">Signed in</th>
                  <th>Last used</th>
                  <th className="hide-narrow">Expires</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
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
                    <td className="muted hide-narrow">{date(s.createdAt)}</td>
                    <td className="muted">{ago(s.lastUsedAt)}</td>
                    <td className="muted hide-narrow">{date(s.expiresAt)}</td>
                    <td className="num">
                      <Button
                        type="button"
                        variant="destructive-outline"
                        size="sm"
                        disabled={busy === s.id}
                        onClick={() => revoke(s)}
                      >
                        {s.current ? "Sign out" : "Revoke"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StackTable>
        </div>
      )}
    </>
  );
}
