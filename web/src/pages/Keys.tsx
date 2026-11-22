import { useMemo, useState } from "react";
import { forgetKeys, loadKeys } from "../account-keys.js";
import { api, type CheckStatus, type Key, type ProviderInfo, why } from "../api.js";
import { ago, date, num } from "../format.js";
import { anyProvider } from "../site.js";
import { PageHead, ProviderLogo, useLoad, useProviders } from "../ui.js";
import { AddKeyDrawer, formats, POPULAR } from "./KeyDrawer.js";

// Like the channel pages of API relays: the page lists the keys you have;
// adding one happens in a drawer (KeyDrawer.tsx).

export function Keys() {
  const providers = useProviders();
  const { data: keys, error: keysError, reload: load } = useLoad(loadKeys);
  // A save, a test or a delete changes what every page reads.
  const reload = () => {
    forgetKeys();
    load();
  };
  const [drawer, setDrawer] = useState<{ provider: string | null } | null>(null);
  const info = useMemo(() => new Map((providers ?? []).map((p) => [p.name, p])), [providers]);
  const list = keys?.keys ?? [];

  return (
    <>
      <PageHead
        title="Provider keys"
        sub="Bring your own key. ocra calls the provider with it, and the provider bills you directly."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setDrawer({ provider: null })}
          >
            + Add key
          </button>
        }
      />
      {keysError ? <p className="error">Could not load keys: {why(keysError)}.</p> : null}
      {keys && list.length === 0 ? (
        <div className="card empty-hero">
          <h3>No provider keys yet</h3>
          <p>
            Add a key from {anyProvider(providers?.length)}. It is encrypted at rest and never shown
            again.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setDrawer({ provider: null })}
          >
            Add your first key
          </button>
          <div className="quick">
            {POPULAR.slice(0, 6)
              .map((n) => info.get(n))
              .filter((p): p is ProviderInfo => !!p)
              .map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="chip"
                  onClick={() => setDrawer({ provider: p.name })}
                >
                  <ProviderLogo label={p.label} size={22} />
                  {p.label}
                </button>
              ))}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap stack">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Key</th>
                  <th>Status</th>
                  <th className="hide-narrow">Last used</th>
                  <th className="num hide-narrow">Requests, 7d</th>
                  <th className="hide-narrow">Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((k) => (
                  <KeyRow
                    key={k.provider}
                    k={k}
                    p={info.get(k.provider)}
                    onChanged={reload}
                    onReplace={() => setDrawer({ provider: k.provider })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="subtle small keys-foot">
        Each key is encrypted with its own data key, wrapped by a master key kept apart from the
        database. Set a spending limit at your provider as well.
      </p>
      {drawer && providers && (
        <AddKeyDrawer
          providers={providers.filter((p) => !p.managed)}
          configured={new Set(list.map((k) => k.provider))}
          initial={drawer.provider}
          onClose={() => setDrawer(null)}
          onSaved={reload}
        />
      )}
    </>
  );
}

function StatusBadge(props: {
  status: CheckStatus | null;
  checkable: boolean;
  checkedAt: string | null;
}) {
  const when = props.checkedAt ? `checked ${ago(props.checkedAt)}` : "";
  switch (props.status) {
    case "ok":
      return (
        <span className="badge badge-ok" title={when}>
          <span className="dot" />
          Verified
        </span>
      );
    case "invalid":
      return (
        <span className="badge badge-err" title={when}>
          <span className="dot" />
          Rejected
        </span>
      );
    case "error":
      return (
        <span className="badge badge-warn" title={when}>
          <span className="dot" />
          Check failed
        </span>
      );
    default:
      return (
        <span
          className="badge"
          title={props.checkable ? "" : "This provider cannot check a key in advance"}
        >
          Not checked
        </span>
      );
  }
}

function KeyRow(props: {
  k: Key;
  p: ProviderInfo | undefined;
  onChanged: () => void;
  onReplace: () => void;
}) {
  const { k, p } = props;
  const [busy, setBusy] = useState<"" | "test" | "delete">("");
  const [confirm, setConfirm] = useState(false);
  const label = p?.label ?? k.provider;
  const [failed, setFailed] = useState("");
  const act = async (kind: "test" | "delete", run: () => Promise<unknown>) => {
    setBusy(kind);
    setFailed("");
    try {
      await run();
      props.onChanged();
    } catch (e) {
      setFailed(`Could not ${kind === "test" ? "test" : "delete"} the key: ${why(e)}.`);
    } finally {
      setBusy("");
    }
  };
  const test = () => act("test", () => api(`/keys/${k.provider}/test`, { method: "POST" }));
  const remove = () => act("delete", () => api(`/keys/${k.provider}`, { method: "DELETE" }));
  return (
    <tr>
      <td>
        <div className="key-name">
          <ProviderLogo label={label} size={28} />
          <div>
            <div className="strong">{label}</div>
            <div className="subtle small">{p ? formats(p) : ""}</div>
          </div>
        </div>
      </td>
      {k.managed ? (
        <td className="muted">Provided by this server</td>
      ) : (
        <td className="mono">••••{k.last4}</td>
      )}
      <td>
        <StatusBadge status={k.checkStatus} checkable={k.checkable} checkedAt={k.checkedAt} />
      </td>
      <td className="muted hide-narrow">{ago(k.lastUsedAt)}</td>
      <td className="num hide-narrow">{num(k.calls7d)}</td>
      <td className="muted hide-narrow">{k.createdAt ? date(k.createdAt) : "–"}</td>
      <td>
        <div className="row-actions">
          {confirm ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-danger-solid"
                disabled={busy !== ""}
                onClick={remove}
              >
                Delete
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {k.checkable && (
                <button type="button" className="btn btn-sm" disabled={busy !== ""} onClick={test}>
                  {busy === "test" ? "Testing…" : "Test"}
                </button>
              )}
              {!k.managed && (
                <>
                  <button type="button" className="btn btn-sm" onClick={props.onReplace}>
                    Replace
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => setConfirm(true)}
                  >
                    Delete
                  </button>
                </>
              )}
            </>
          )}
        </div>
        {failed && (
          <div className="error small" role="alert">
            {failed}
          </div>
        )}
      </td>
    </tr>
  );
}
