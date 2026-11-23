import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type {
  AutoEnrollInstallationsView,
  AutoEnrollInstallationView,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { useRead } from "../cache.js";
import { useAction } from "../ui.js";

// Each GitHub App installation the user reaches may enroll the repositories
// added to it from then on, reviewed only when asked unless the second
// choice is on. One account at a time enrolls an installation's.

/** Why the choice was refused: the server's words when it names the field, else the usual ones. */
function refusal(e: unknown): string {
  return (e instanceof ApiError && e.issues[0]?.message) || why(e);
}

function Installation(props: { i: AutoEnrollInstallationView }) {
  const [now, setNow] = useState(props.i);
  const save = useAction((next: { enabled: boolean; automatic: boolean }) =>
    api<AutoEnrollInstallationView>(
      `/auto-review/installations/${encodeURIComponent(props.i.id)}/auto-enroll`,
      { method: "PUT", body: JSON.stringify(next) },
    ),
  );
  const change = async (next: { enabled: boolean; automatic: boolean }) => {
    const before = now;
    setNow({ ...now, ...next });
    const saved = await save.run(next);
    setNow(saved ? { ...before, enabled: saved.enabled, automatic: saved.automatic } : before);
  };
  return (
    <li>
      <span className="mono strong">{now.owner}</span>
      <span className="with-mark">
        <Switch
          aria-label={`Enroll new repositories of ${now.owner}`}
          checked={now.enabled}
          disabled={save.busy}
          onCheckedChange={(enabled) => change({ enabled, automatic: enabled && now.automatic })}
        />
        <span className="subtle small">
          {now.enabled ? "New repositories are added" : "New repositories are not added"}
        </span>
      </span>
      {now.enabled && (
        <label className="check small">
          <input
            type="checkbox"
            checked={now.automatic}
            disabled={save.busy}
            onChange={(e) => change({ enabled: true, automatic: e.target.checked })}
          />
          Also review each pull request as it opens
        </label>
      )}
      {save.error !== null && (
        <span className="error-inline small" role="alert">
          Could not change it: {refusal(save.error)}.
        </span>
      )}
    </li>
  );
}

export function AutoEnroll() {
  const { data } = useRead<AutoEnrollInstallationsView>("/auto-review/installations");
  if (!data || data.installations.length === 0) return null;
  return (
    <section className="card card-pad stack add-form" aria-label="New repositories">
      <div>
        <h2 className="card-title">New repositories</h2>
        <span className="subtle small">
          Add the repositories that join a GitHub App installation later, without coming back here.
        </span>
      </div>
      <ul className="install-rows">
        {data.installations.map((i) => (
          <Installation key={i.id} i={i} />
        ))}
      </ul>
      {data.more && (
        <span className="subtle small">GitHub lists more installations than are shown here.</span>
      )}
    </section>
  );
}
