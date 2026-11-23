import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type {
  AutoEnrollGroupsView,
  AutoEnrollInstallationsView,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { useRead } from "../cache.js";
import { useAction } from "../ui.js";

// A GitHub App installation, or a GitLab group the user maintains, may
// enroll the repositories that join it from then on, reviewed only when
// asked unless the second choice is on. One account at a time enrolls them.

type Source = { id: string; name: string; enabled: boolean; automatic: boolean };
type Choice = { enabled: boolean; automatic: boolean };

/** Why the choice was refused: the server's words when it names the field, else the usual ones. */
function refusal(e: unknown): string {
  return (e instanceof ApiError && e.issues[0]?.message) || why(e);
}

function Row(props: { source: Source; what: string; opens: string; put: string }) {
  const [now, setNow] = useState(props.source);
  const save = useAction((next: Choice) =>
    api<Choice>(props.put, { method: "PUT", body: JSON.stringify(next) }),
  );
  const change = async (next: Choice) => {
    const before = now;
    setNow({ ...now, ...next });
    const saved = await save.run(next);
    setNow(saved ? { ...before, enabled: saved.enabled, automatic: saved.automatic } : before);
  };
  return (
    <li>
      <span className="mono strong">{now.name}</span>
      <span className="with-mark">
        <Switch
          aria-label={`Enroll new ${props.what} of ${now.name}`}
          checked={now.enabled}
          disabled={save.busy}
          onCheckedChange={(enabled) => change({ enabled, automatic: enabled && now.automatic })}
        />
        <span className="subtle small">
          {now.enabled ? `New ${props.what} are added` : `New ${props.what} are not added`}
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
          Also review each {props.opens} as it opens
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

function Card(props: {
  title: string;
  sub: string;
  what: string;
  opens: string;
  sources: Source[];
  put: (id: string) => string;
  more: string | false;
}) {
  if (props.sources.length === 0) return null;
  return (
    <section className="card card-pad stack add-form" aria-label={props.title}>
      <div>
        <h2 className="card-title">{props.title}</h2>
        <span className="subtle small">{props.sub}</span>
      </div>
      <ul className="install-rows">
        {props.sources.map((s) => (
          <Row key={s.id} source={s} what={props.what} opens={props.opens} put={props.put(s.id)} />
        ))}
      </ul>
      {props.more && <span className="subtle small">{props.more}</span>}
    </section>
  );
}

export function AutoEnroll() {
  const { data } = useRead<AutoEnrollInstallationsView>("/auto-review/installations");
  if (!data) return null;
  return (
    <Card
      title="New repositories"
      sub="Add the repositories that join a GitHub App installation later, without coming back here."
      what="repositories"
      opens="pull request"
      sources={data.installations.map((i) => ({ ...i, name: i.owner }))}
      put={(id) => `/auto-review/installations/${encodeURIComponent(id)}/auto-enroll`}
      more={data.more && "GitHub lists more installations than are shown here."}
    />
  );
}

export function GroupEnroll() {
  const { data } = useRead<AutoEnrollGroupsView>("/auto-review/gitlab/groups");
  if (!data) return null;
  return (
    <Card
      title="New GitLab projects"
      sub="Add the projects created in a group you maintain from now on. ocra looks once a day, and leaves the projects a group already has to you."
      what="projects"
      opens="merge request"
      sources={data.groups.map((g) => ({ ...g, name: g.fullPath }))}
      put={(id) => `/auto-review/gitlab/groups/${encodeURIComponent(id)}/auto-enroll`}
      more={data.more && "GitLab lists more groups than are shown here."}
    />
  );
}
