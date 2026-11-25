import { type SubmitEvent, useEffect, useState } from "react";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "../api.js";
import { ago } from "../format.js";
import { DoneGlyph } from "../glyphs.js";
import { PageHead } from "../ui.js";

type Info = { user_code: string; label: string | null; createdAt: string };
type State = "enter" | "confirm" | "approved" | "denied";

/** Where a signed-in user approves an `ocra login` from a terminal. */
export function Device() {
  const initial = new URLSearchParams(location.search).get("code") ?? "";
  const [code, setCode] = useState(initial);
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<State>("enter");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const lookup = async (value: string) => {
    setError("");
    setBusy(true);
    try {
      const found = await api<Info>(`/device/info?user_code=${encodeURIComponent(value)}`);
      setInfo(found);
      setState("confirm");
    } catch {
      setError("That code is unknown or has expired. Run ocra login again for a new one.");
    } finally {
      setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: look up the code from the link once
  useEffect(() => {
    if (initial) void lookup(initial);
  }, []);

  const decide = async (approve: boolean) => {
    if (!info) return;
    setBusy(true);
    setError("");
    try {
      await api("/device/decide", {
        method: "POST",
        body: JSON.stringify({ user_code: info.user_code, approve }),
      });
      setState(approve ? "approved" : "denied");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "This code was already used."
          : "Could not record that.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    void lookup(code);
  };

  return (
    <>
      <PageHead title="Sign in a terminal" sub="Connect the ocra CLI to your account." />
      <div className="card card-pad device-card">
        {state === "enter" && (
          <form onSubmit={submit}>
            <div className="field mt-0">
              <label htmlFor="user-code">Code shown in your terminal</label>
              <input
                id="user-code"
                className="input mono code-input"
                placeholder="XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                // biome-ignore lint/a11y/noAutofocus: the page exists to type this code
                autoFocus
              />
            </div>
            <div className="device-submit">
              <Button type="submit" disabled={busy || code.replace(/[^a-z]/gi, "").length !== 8}>
                Continue
              </Button>
            </div>
          </form>
        )}
        {state === "confirm" && info && (
          <>
            <div className="muted small">Confirm this code matches your terminal:</div>
            <div className="mono device-code">{info.user_code}</div>
            <dl className="kv m-0">
              <dt>Terminal</dt>
              <dd>
                {info.label ?? "Unnamed"}{" "}
                <Status tone="warn" title="The terminal chose this name">
                  Unverified
                </Status>
                <div className="muted small">
                  The name was sent by whoever asked for the code. ocra cannot check it.
                </div>
              </dd>
              <dt>Requested</dt>
              <dd>{ago(info.createdAt)}</dd>
              <dt>It will be able to</dt>
              <dd>
                call models with your stored keys and upload review results. It cannot read your
                keys or change your account.
              </dd>
            </dl>
            <div className="note err">
              Approve only if you just ran <span className="mono">ocra login</span> yourself.
              Someone who sent you this code could use your keys.
            </div>
            <div className="device-actions">
              <Button type="button" disabled={busy} onClick={() => decide(true)}>
                Approve
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => decide(false)}>
                Deny
              </Button>
            </div>
          </>
        )}
        {state === "approved" && (
          <div className="note ok mt-0">
            <DoneGlyph /> Terminal signed in. You can return to it; it will continue on its own.
          </div>
        )}
        {state === "denied" && <div className="note">Denied. The terminal was not signed in.</div>}
        {error && <p className="error mb-0">{error}</p>}
      </div>
    </>
  );
}
