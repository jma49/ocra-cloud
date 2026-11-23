import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, type Me } from "../api.js";
import { date, num } from "../format.js";
import { ActionError, LoadError, Loading, PageHead, useLoad } from "../ui.js";

type SharingLoad = ReturnType<typeof useSharing>;

function useSharing() {
  return useLoad(() =>
    api<{
      shareFindings: boolean;
      hostedFindings: boolean;
      findingsStored: number;
      findingsAllowance: number;
    }>("/account/sharing"),
  );
}

/**
 * What the account keeps, true for the sharing setting when it is known
 * (audit C2): with findings sent, their quoted code is kept too.
 */
function dataKept(shareFindings: boolean | undefined, hosted: boolean): string {
  const kept =
    "Your sign-in id and login, encrypted provider keys, review counts and a record of each model call (model, status, token counts, duration)";
  if (shareFindings === true) {
    return `${kept}; while you send findings, also the findings and the code they quote. No prompts or answers.`;
  }
  if (hosted) {
    return `${kept}; for reviews ocra runs here, also their findings and the code they quote. No prompts or answers.`;
  }
  if (shareFindings === false) return `${kept}. No code, prompts or answers.`;
  return `${kept}. No prompts or answers; code only in findings you choose to send.`;
}

export function Settings(props: { me: Me }) {
  const sharing = useSharing();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<unknown>(null);
  const remove = async () => {
    setError(null);
    try {
      await api("/account", { method: "DELETE", body: JSON.stringify({ confirm: typed }) });
      location.href = "/";
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <PageHead
        title="Account & privacy"
        sub="Who you are signed in as, what ocra Cloud keeps for you, and how to take it with you or delete it."
      />
      <div className="card">
        <div className="card-head">
          <h2>Account</h2>
        </div>
        <dl className="kv card-pad m-0">
          <dt>{props.me.githubId !== null ? "GitHub" : "Login"}</dt>
          <dd>
            {props.me.githubUrl && props.me.githubId !== null ? (
              <a href={`${props.me.githubUrl}/${props.me.login}`} target="_blank" rel="noreferrer">
                {props.me.login}
              </a>
            ) : (
              props.me.login
            )}
          </dd>
          <dt>Member since</dt>
          <dd>{date(props.me.since)}</dd>
          <dt>Data kept</dt>
          <dd className="muted">
            {dataKept(
              sharing.data?.shareFindings,
              props.me.autoReview && sharing.data?.hostedFindings === true,
            )}
          </dd>
        </dl>
      </div>

      <Sharing load={sharing} />
      {props.me.autoReview && <HostedFindings load={sharing} />}

      <div className="section card">
        <div className="card-head">
          <h2>Your data</h2>
        </div>
        <div className="card-pad export-row">
          <span className="muted small">
            Download everything stored for your account as JSON. Records are kept 90 days;{" "}
            <a href="/privacy">data policy</a>.
          </span>
          <Button variant="outline" render={<a href="/api/export" download />}>
            Export my data
          </Button>
        </div>
      </div>

      <div className="section card danger-zone">
        <div className="card-head">
          <h2>Delete account</h2>
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
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={typed !== props.me.login}
              onClick={remove}
            >
              Delete my account
            </Button>
          </div>
          {error !== null && <ActionError what="delete the account" error={error} />}
        </div>
      </div>
    </>
  );
}

/** A switch of the sharing setting: turning it off asks first whether to delete what is stored. */
function useSharingSwitch(path: string, reload: () => void) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const put = async (enabled: boolean, deleteExisting = false) => {
    setBusy(true);
    setFailed(null);
    const error = await api(path, {
      method: "PUT",
      body: JSON.stringify({ enabled, deleteExisting }),
    }).then(
      () => null,
      (e: unknown) => e ?? new Error("refused"),
    );
    setBusy(false);
    setFailed(error);
    if (error === null) setAsking(false);
    reload();
  };
  return { asking, setAsking, busy, failed, put };
}

/** Whether reviews this server runs keep their findings: on from the first one, until switched off. */
function HostedFindings({ load }: { load: SharingLoad }) {
  const { data, reload } = load;
  const { asking, setAsking, busy, failed, put } = useSharingSwitch(
    "/account/sharing/hosted",
    reload,
  );
  if (!data) return null;
  return (
    <div className="section card">
      <div className="card-head">
        <h2>Keep the findings of reviews ocra runs here</h2>
        <Switch
          aria-label="Keep the findings of reviews ocra runs here"
          checked={data.hostedFindings}
          disabled={busy}
          onCheckedChange={() => (data.hostedFindings ? setAsking(true) : put(true))}
        />
      </div>
      <div className="card-pad small muted stack">
        <span>
          On by default. A review this server runs for a repository with auto review on keeps its
          findings and <b>the code each finding quotes</b>, redacted the same way, so they show on
          the pull request, the review and the findings pages. The server already read that code to
          review it. Reviews from your own machine send theirs only with the switch above.
        </span>
        {failed !== null && (
          <ActionError what="change this setting (nothing was deleted)" error={failed} />
        )}
        {asking && (
          <div className="note confirm-note">
            <span>
              Stop keeping them.
              {data.shareFindings
                ? " Findings already stored stay while you send findings."
                : ` Delete the ${data.findingsStored} already stored too?`}
            </span>
            {!data.shareFindings && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => put(false, true)}
              >
                Turn off and delete
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => put(false)}
            >
              {data.shareFindings ? "Turn off" : "Turn off, keep them"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Sharing({ load }: { load: SharingLoad }) {
  const { data, error, reload } = load;
  const { asking, setAsking, busy, failed, put } = useSharingSwitch("/account/sharing", reload);
  const title = <h2>Send findings and the code they quote to ocra Cloud</h2>;
  if (!data) {
    return (
      <div className="section card">
        <div className="card-head">{title}</div>
        {error ? (
          <LoadError what="the sharing setting" error={error} retry={reload} inCard />
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
        <Switch
          aria-label="Send findings and the code they quote"
          checked={data.shareFindings}
          disabled={busy}
          onCheckedChange={() => (data.shareFindings ? setAsking(true) : put(true))}
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
        <span>
          Up to {num(data.findingsAllowance)} findings can be sent in any 90 days; deleting findings
          does not give that room back.
        </span>
        <span className="subtle">
          {data.findingsStored} finding{data.findingsStored === 1 ? "" : "s"} stored now.
        </span>
        {failed !== null && (
          <ActionError what="change this setting (nothing was deleted)" error={failed} />
        )}
        {asking && (
          <div className="note confirm-note">
            <span>Stop sending findings. Delete the {data.findingsStored} already sent too?</span>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => put(false, true)}
            >
              Turn off and delete
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => put(false)}
            >
              Turn off, keep them
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
