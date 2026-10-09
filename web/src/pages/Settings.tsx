import { useState } from "react";
import { api, type Me } from "../api.js";
import { date } from "../format.js";
import { LoadError, Loading, PageHead, useLoad } from "../ui.js";

type SharingLoad = ReturnType<typeof useSharing>;

function useSharing() {
  return useLoad(() => api<{ shareFindings: boolean; findingsStored: number }>("/account/sharing"));
}

/**
 * What the account keeps, true for the sharing setting when it is known
 * (audit C2): with findings sent, their quoted code is kept too.
 */
function dataKept(shareFindings: boolean | undefined): string {
  const kept =
    "Your GitHub id and login, encrypted provider keys, review counts and a record of each model call (model, status, token counts, duration)";
  if (shareFindings === true) {
    return `${kept}; while you send findings, also the findings and the code they quote. No prompts or answers.`;
  }
  if (shareFindings === false) return `${kept}. No code, prompts or answers.`;
  return `${kept}. No prompts or answers; code only in findings you choose to send.`;
}

export function Settings(props: { me: Me }) {
  const sharing = useSharing();
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
        <dl className="kv card-pad m-0">
          <dt>GitHub</dt>
          <dd>
            <a href={`https://github.com/${props.me.login}`} target="_blank" rel="noreferrer">
              {props.me.login}
            </a>
          </dd>
          <dt>Member since</dt>
          <dd>{date(props.me.since)}</dd>
          <dt>Data kept</dt>
          <dd className="muted">{dataKept(sharing.data?.shareFindings)}</dd>
        </dl>
      </div>

      <Sharing load={sharing} />

      <div className="section card">
        <div className="card-head">
          <h3>Your data</h3>
        </div>
        <div className="card-pad export-row">
          <span className="muted small">
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
          <p className="muted small mt-0">
            Deletes your account, every stored key and all records now. This cannot be undone. Type{" "}
            <b className="mono">{props.me.login}</b> to confirm.
          </p>
          <div className="row-gap wrap">
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

function Sharing({ load }: { load: SharingLoad }) {
  const { data, error, reload } = load;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const put = async (enabled: boolean, deleteExisting = false) => {
    setBusy(true);
    setFailed(false);
    const ok = await api("/account/sharing", {
      method: "PUT",
      body: JSON.stringify({ enabled, deleteExisting }),
    }).then(
      () => true,
      () => false,
    );
    setBusy(false);
    setFailed(!ok);
    if (ok) setAsking(false);
    reload();
  };
  const title = <h3>Send findings and the code they quote to ocra Cloud</h3>;
  if (!data) {
    return (
      <div className="section card">
        <div className="card-head">{title}</div>
        {error ? (
          <LoadError what="the sharing setting" error={error} retry={reload} />
        ) : (
          <Loading what="the sharing setting" />
        )}
      </div>
    );
  }
  return (
    <div className="section card">
      <div className="card-head">
        {title}
        <button
          type="button"
          role="switch"
          className="switch"
          aria-label="Send findings and the code they quote"
          aria-checked={data.shareFindings}
          disabled={busy}
          onClick={() => (data.shareFindings ? setAsking(true) : put(true))}
        />
      </div>
      <div className="card-pad small muted stack">
        <span>
          Off by default. When on, each signed-in review also sends its findings: file paths, line
          ranges, titles, descriptions, suggestions and <b>the code each finding quotes</b>, after
          replacing secret-looking tokens with [redacted] (this catches common patterns, not every
          secret). You can then open a review's findings here, download them, and remember findings
          so later reviews stop reporting them. Kept 90 days with their review.
        </span>
        <span className="subtle">{data.findingsStored} finding(s) stored now.</span>
        {failed && (
          <span className="error" role="alert">
            Could not change this setting; nothing was deleted. Try again.
          </span>
        )}
        {asking && (
          <div className="note confirm-note">
            <span>Stop sending findings. Delete the {data.findingsStored} already sent too?</span>
            <button
              type="button"
              className="btn btn-sm btn-danger-solid"
              disabled={busy}
              onClick={() => put(false, true)}
            >
              Turn off and delete
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => put(false)}>
              Turn off, keep them
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
