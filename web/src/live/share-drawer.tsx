import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { LiveRole, LiveShareView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { Drawer } from "../drawer.js";
import { useToast } from "../toast.js";
import { ActionError, Seg, useAction } from "../ui.js";

// Who besides the owner may watch a run: people by their sign-in name, and
// one link for anyone signed in to this server. Viewers see file paths and
// finding text, so nothing is shared until the owner says so.

const ROLES: { value: LiveRole; label: string }[] = [
  { value: "watch", label: "Can watch" },
  { value: "comment", label: "Can comment" },
];

export function ShareDrawer(props: {
  id: string;
  share: LiveShareView;
  onChange: (share: LiveShareView) => void;
  onClose: () => void;
}) {
  const { id, share, onChange } = props;
  const toast = useToast();
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<LiveRole>("comment");
  const send = useAction(async (path: string, method: string, body?: unknown) => {
    const next = await api<LiveShareView>(`/live/${id}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    onChange(next);
    return next;
  });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await send.run("/people", "POST", { login: login.trim(), role })) setLogin("");
  };
  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  };

  return (
    <Drawer title="Share this review" onClose={props.onClose}>
      <p className="note">
        People you share with see the run as it goes: file paths, findings and their text. They
        can't share it further.
      </p>
      {send.error !== null && <ActionError what="change who can see this run" error={send.error} />}

      <section className="share-section" aria-label="People">
        <h3>People</h3>
        <form className="share-add" onSubmit={add}>
          <input
            className="input"
            aria-label="Sign-in name"
            placeholder="Sign-in name, for example mona"
            value={login}
            maxLength={100}
            onChange={(e) => setLogin(e.target.value)}
          />
          <select
            className="input"
            aria-label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value as LiveRole)}
          >
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" disabled={send.busy || login.trim() === ""}>
            Add
          </Button>
        </form>
        {share.people.length === 0 ? (
          <p className="subtle small m-0">Nobody yet. They need to have signed in here once.</p>
        ) : (
          <ul className="share-people">
            {share.people.map((p) => (
              <li key={p.id}>
                <span className="grow">{p.login}</span>
                <select
                  className="input"
                  aria-label={`${p.login}'s role`}
                  value={p.role}
                  disabled={send.busy}
                  onChange={(e) =>
                    send.run("/people", "POST", { login: p.login, role: e.target.value })
                  }
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={send.busy}
                  onClick={() => send.run(`/people/${p.id}`, "DELETE")}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="share-section" aria-label="Link">
        <div className="share-link-head">
          <h3>Anyone with the link</h3>
          <Switch
            aria-label="Share by link"
            checked={share.link !== null}
            disabled={send.busy}
            onCheckedChange={(on) =>
              on ? send.run("/link", "PUT", { role: "watch" }) : send.run("/link", "DELETE")
            }
          />
        </div>
        <p className="subtle small m-0">
          {share.link
            ? "Anyone signed in to this server who has the link."
            : "Off. Turn it on to get a link to send."}
        </p>
        {share.link && (
          <div className="share-link">
            <Seg
              label="What the link allows"
              value={share.link.role}
              options={ROLES}
              onChange={(r) => send.run("/link", "PUT", { role: r })}
            />
            <div className="share-link-row">
              <input className="input mono" aria-label="Link" readOnly value={share.link.url} />
              <Button type="button" onClick={() => share.link && copy(share.link.url)}>
                Copy link
              </Button>
            </div>
            <div className="share-link-row">
              <p className="subtle small m-0 grow">A new link stops the old one from working.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={send.busy}
                onClick={() =>
                  share.link && send.run("/link", "PUT", { role: share.link.role, replace: true })
                }
              >
                New link
              </Button>
            </div>
          </div>
        )}
      </section>
    </Drawer>
  );
}
