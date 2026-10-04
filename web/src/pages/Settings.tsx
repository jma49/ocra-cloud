import { useState } from "react";
import { api, date, type Me } from "../api.js";
import { PageHead } from "../ui.js";

export function Settings(props: { me: Me }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const remove = async () => {
    try {
      await api("/account", { method: "DELETE", body: JSON.stringify({ confirm: typed }) });
      location.href = "/";
    } catch {
      setError("Could not delete the account.");
    }
  };
  return (
    <>
      <PageHead title="Settings" />
      <div className="card">
        <div className="card-head">
          <h3>Account</h3>
        </div>
        <dl className="kv card-pad" style={{ margin: 0 }}>
          <dt>GitHub</dt>
          <dd>
            <a href={`https://github.com/${props.me.login}`} target="_blank" rel="noreferrer">
              {props.me.login}
            </a>
          </dd>
          <dt>Member since</dt>
          <dd>{date(props.me.since)}</dd>
          <dt>Data kept</dt>
          <dd className="muted">
            Your GitHub id and login, encrypted provider keys, and a record of each model call
            (model, status, token counts, duration). No code, prompts or answers.
          </dd>
        </dl>
      </div>

      <div className="section card">
        <div className="card-head">
          <h3>Your data</h3>
        </div>
        <div
          className="card-pad"
          style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
        >
          <span className="muted small" style={{ flex: 1, minWidth: 240 }}>
            Download everything stored for your account as JSON. Records are kept 90 days;{" "}
            <a href="/privacy">data policy</a>.
          </span>
          <a className="btn" href="/api/export" download>
            Export my data
          </a>
        </div>
      </div>

      <div className="section card danger-zone">
        <div className="card-head">
          <h3>Delete account</h3>
        </div>
        <div className="card-pad">
          <p className="muted small" style={{ marginTop: 0 }}>
            Deletes your account, every stored key and all records now. This cannot be undone. Type{" "}
            <b className="mono">{props.me.login}</b> to confirm.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={props.me.login}
              aria-label="Type your login to confirm"
            />
            <button
              type="button"
              className="btn btn-danger-solid"
              disabled={typed !== props.me.login}
              onClick={remove}
            >
              Delete my account
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    </>
  );
}
