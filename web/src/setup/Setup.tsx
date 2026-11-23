import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SetupSettingsView, SetupState } from "../../../src/shared/index.js";
import { ApiError, api } from "../api.js";
import { Link } from "../router.js";
import { useToast } from "../toast.js";
import { ActionError, LoadError, Loading, PageHead, useAction } from "../ui.js";
import { HealthView } from "./checks.js";
import { CodeHostForm, ModelsForm, StepForm } from "./forms.js";
import { NETWORK, SIGN_IN, STEPS, type StepId } from "./steps.js";

// The server's settings page (/setup): what an operator opens first, while
// nobody can sign in, and comes back to later. It opens with the setup code
// from the server's log, holds a step per connection, each tested before it
// is saved, and starts the server again with what was saved.

const POLL_MS = 1_000;

export function Setup() {
  const [view, setView] = useState<SetupSettingsView | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [step, setStep] = useState<StepId>("network");
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api<SetupSettingsView>("/setup/settings").then(
      (v) => {
        setLocked(false);
        setView(v);
      },
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setLocked(true);
        else setError(e);
      },
    );
  }, []);
  useEffect(load, [load]);

  const onSaved = (v: SetupSettingsView) => {
    setView(v);
    setSaved(true);
  };

  return (
    <>
      <PageHead
        title="Set up ocra Cloud"
        sub="Connect this server to your company's network, sign-in, code host and models. Each step tests its connection before you save it."
      />
      {locked ? (
        <Unlock onOpen={load} />
      ) : error ? (
        <LoadError what="the settings" error={error} retry={load} />
      ) : !view ? (
        <Loading what="the settings" />
      ) : (
        <div className="setup-layout">
          <nav className="settings-nav setup-nav" aria-label="Setup steps">
            {STEPS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings-link${s.id === step ? " on" : ""}`}
                aria-current={s.id === step ? "step" : undefined}
                onClick={() => setStep(s.id)}
              >
                <s.icon size={16} className="nav-icon" aria-hidden="true" />
                {s.label}
              </button>
            ))}
          </nav>
          <div className="setup-main">
            {saved && <Restart onDone={() => setSaved(false)} />}
            {step === "network" && (
              <StepForm
                title="Network"
                sub="How this server reaches your company's hosts. The tests on the other steps go through it."
                form={NETWORK}
                view={view}
                onSaved={onSaved}
              />
            )}
            {step === "signIn" && (
              <StepForm
                title="Single sign-on"
                sub="People sign in through your OpenID Connect provider. Register ocra there as a confidential client with the redirect URI below, scopes openid profile email."
                form={SIGN_IN}
                view={view}
                onSaved={onSaved}
              />
            )}
            {step === "host" && <CodeHostForm view={view} onSaved={onSaved} />}
            {step === "models" && <ModelsForm view={view} onSaved={onSaved} />}
            {step === "health" && <HealthView />}
          </div>
        </div>
      )}
    </>
  );
}

function Unlock(props: { onOpen: () => void }) {
  const [code, setCode] = useState("");
  const open = useAction((typed: string) =>
    api("/setup/unlock", { method: "POST", body: JSON.stringify({ code: typed }) }),
  );
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((await open.run(code)) !== undefined) props.onOpen();
  };
  return (
    <form className="card setup-unlock" onSubmit={submit}>
      <div className="card-head">
        <h2>Enter the setup code</h2>
      </div>
      <div className="card-pad">
        <p className="muted m-0">
          The server prints it in its log while nobody can sign in. On the server, run{" "}
          <code className="mono">docker compose logs ocra</code>, or at any time{" "}
          <code className="mono">docker compose exec ocra node dist/setup-code.mjs</code>.
        </p>
        <div className="field">
          <label htmlFor="setup-code">Setup code</label>
          <div className="setup-code-line">
            <input
              id="setup-code"
              className="input mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={!code.trim() || open.busy}>
              Open settings
            </Button>
          </div>
        </div>
        {open.error !== null &&
          (refused(open.error) ? (
            <p className="error setup-refused" role="alert">
              {refused(open.error)}
            </p>
          ) : (
            <ActionError what="open the settings" error={open.error} />
          ))}
      </div>
    </form>
  );
}

/** Why the code did not open the settings, when the server said: a wrong code, or too many tries. */
function refused(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status === 401) return "That is not this server's code. Check it against the log.";
  if (error.status === 429) return "Too many tries: wait a minute, then try again.";
  return undefined;
}

/** Starts the server again with the saved settings, then waits for it to answer. */
function Restart(props: { onDone: () => void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<"saved" | "restarting" | "ready">("saved");
  const [needed, setNeeded] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const restart = async () => {
    setError(null);
    try {
      const before = await api<SetupState>("/setup");
      await api("/setup/apply", { method: "POST", body: "{}" });
      setPhase("restarting");
      for (;;) {
        await new Promise((done) => setTimeout(done, POLL_MS));
        const now = await api<SetupState>("/setup").catch(() => undefined);
        if (now && now.startedAt > before.startedAt) {
          setNeeded(now.needed);
          break;
        }
      }
      setPhase("ready");
      toast("The server runs with the new settings", "success");
    } catch (e) {
      setPhase("saved");
      setError(e);
    }
  };

  if (phase === "ready") {
    return (
      <div className="note ok setup-banner" role="status">
        <span className="grow">
          {needed
            ? "The server runs with the new settings. Nobody can sign in until single sign-on or a GitHub App is set."
            : "The server runs with the new settings, and people can sign in."}
        </span>
        {!needed && (
          <Button size="sm" render={<Link to="/" />}>
            Sign in
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={props.onDone}>
          Done
        </Button>
      </div>
    );
  }
  return (
    <div className="note setup-banner" role="status">
      <span className="grow">
        {phase === "restarting"
          ? "Starting the server again…"
          : "Saved. The server uses saved settings once it starts again, in a few seconds; nothing is lost."}
      </span>
      <Button size="sm" onClick={restart} disabled={phase === "restarting"}>
        Start again now
      </Button>
      {error !== null && <ActionError what="start the server again" error={error} />}
    </div>
  );
}
