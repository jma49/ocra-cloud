import { type FormEvent, useState } from "react";
import {
  NOTIFY_KINDS,
  NOTIFY_WHEN,
  type NotifyChannelsView,
  type NotifyChannelView,
  type NotifyKind,
  type NotifyWhen,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { ago } from "../format.js";
import { ActionError, LoadError, Loading, PageHead, useAction, useLoad } from "../ui.js";

// The chats and email addresses that hear about reviews: a Slack or WeCom
// incoming webhook, or an address confirmed by the link mailed to it, each
// with which reviews it hears about and whether it gets the daily digest.
// The address is sent once and never shown again.

const KIND_LABEL: Record<NotifyKind, string> = { slack: "Slack", wecom: "WeCom", email: "Email" };
const WHEN_LABEL: Record<NotifyWhen, string> = {
  blocking: "Blocking reviews",
  findings: "Reviews with findings",
  every: "Every review",
};
const PLACEHOLDER: Record<NotifyKind, string> = {
  slack: "https://hooks.slack.com/services/…",
  wecom: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…",
  email: "you@example.com",
};
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export function Notifications() {
  const { data, error, reload } = useLoad(() => api<NotifyChannelsView>("/notifications/channels"));
  const [tested, setTested] = useState<{ id: string; delivered: boolean } | null>(null);
  const change = useAction((id: string, body: { when?: NotifyWhen; digest?: boolean }) =>
    api(`/notifications/channels/${id}`, json("PATCH", body)),
  );
  const remove = useAction((id: string) => api(`/notifications/channels/${id}`, json("DELETE")));
  const resend = useAction((id: string) =>
    api<{ confirmationSent: boolean }>(`/notifications/channels/${id}/confirm`, json("POST")),
  );
  const test = useAction((id: string) =>
    api<{ delivered: boolean }>(`/notifications/channels/${id}/test`, json("POST")),
  );
  const after = async (p: Promise<unknown>) => {
    if ((await p) !== undefined) reload();
  };
  const sendTest = async (id: string) => {
    setTested(null);
    const r = await test.run(id);
    if (r) setTested({ id, delivered: r.delivered });
    reload();
  };
  return (
    <>
      <PageHead
        title="Notifications"
        sub="Tell a Slack or WeCom chat, or an email address, when a review lands, and send a daily digest of yesterday's reviews. ocra keeps each address encrypted and never shows it again; an email address first gets a link to confirm it."
      />
      <AddChannel
        onAdded={reload}
        full={(data?.channels.length ?? 0) >= 10}
        email={data?.email ?? false}
      />
      {resend.error !== null && <ActionError what="send the link again" error={resend.error} />}
      {change.error !== null && <ActionError what="change the channel" error={change.error} />}
      {remove.error !== null && <ActionError what="remove the channel" error={remove.error} />}
      {test.error !== null && <ActionError what="send a test message" error={test.error} />}
      {error && !data ? (
        <LoadError what="your channels" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="channels" />
      ) : data.channels.length === 0 ? (
        <p className="subtle small">No channels yet.</p>
      ) : (
        <div className="card">
          <div className="table-wrap stack">
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Sends</th>
                  <th>Digest</th>
                  <th>Last message</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.channels.map((c) => (
                  <tr key={c.id}>
                    <td className="text">
                      <div className="strong">{c.name}</div>
                      <div className="subtle small">
                        {KIND_LABEL[c.kind]} · <span className="mono">…{c.last4}</span>
                      </div>
                    </td>
                    <td>
                      <select
                        className="input"
                        aria-label={`What ${c.name} hears about`}
                        value={c.when}
                        disabled={change.busy}
                        onChange={(e) =>
                          after(change.run(c.id, { when: e.target.value as NotifyWhen }))
                        }
                      >
                        {NOTIFY_WHEN.map((w) => (
                          <option key={w} value={w}>
                            {WHEN_LABEL[w]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Daily digest to ${c.name}`}
                        checked={c.digest}
                        disabled={change.busy}
                        onChange={(e) => after(change.run(c.id, { digest: e.target.checked }))}
                      />
                    </td>
                    <td>
                      {c.confirmed ? (
                        <LastSent c={c} tested={tested?.id === c.id ? tested.delivered : null} />
                      ) : (
                        <span className="subtle">Waiting for the address to be confirmed</span>
                      )}
                    </td>
                    <td className="num nobreak">
                      {c.confirmed ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={test.busy}
                          onClick={() => sendTest(c.id)}
                        >
                          Send test
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={resend.busy}
                          onClick={() => after(resend.run(c.id))}
                        >
                          Send link again
                        </button>
                      )}{" "}
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={remove.busy}
                        onClick={() => after(remove.run(c.id))}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function LastSent(props: { c: NotifyChannelView; tested: boolean | null }) {
  const { c } = props;
  if (props.tested === false) return <span className="badge badge-err">Test not delivered</span>;
  if (props.tested) return <span className="badge badge-ok">Test delivered</span>;
  if (!c.lastStatus) return <span className="subtle">Nothing sent yet</span>;
  return (
    <span className={c.lastStatus === "ok" ? "muted" : "error-inline"}>
      {c.lastStatus === "ok" ? "Delivered" : "Failed"} {ago(c.lastSentAt)}
    </span>
  );
}

function AddChannel(props: { onAdded: () => void; full: boolean; email: boolean }) {
  const [kind, setKind] = useState<NotifyKind>("slack");
  const [name, setName] = useState("");
  const [when, setWhen] = useState<NotifyWhen>("blocking");
  const [url, setUrl] = useState("");
  const add = useAction(() =>
    api(
      "/notifications/channels",
      json("POST", {
        kind,
        name: name.trim(),
        when,
        ...(kind === "email" ? { address: url.trim() } : { url }),
      }),
    ),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ((await add.run()) === undefined) return;
    setName("");
    setUrl("");
    props.onAdded();
  };
  return (
    <form className="card card-pad stack add-form" onSubmit={submit}>
      <div className="strong">Add a channel</div>
      <div className="add-fields">
        <select
          className="input"
          aria-label="Chat"
          value={kind}
          onChange={(e) => setKind(e.target.value as NotifyKind)}
        >
          {NOTIFY_KINDS.filter((k) => k !== "email" || props.email).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input
          className="input"
          aria-label="Name"
          placeholder="Name, e.g. #payments-reviews"
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className="input"
          aria-label="Sends"
          value={when}
          onChange={(e) => setWhen(e.target.value as NotifyWhen)}
        >
          {NOTIFY_WHEN.map((w) => (
            <option key={w} value={w}>
              {WHEN_LABEL[w]}
            </option>
          ))}
        </select>
        <input
          className="input grow mono"
          aria-label={kind === "email" ? "Email address" : "Webhook address"}
          placeholder={PLACEHOLDER[kind]}
          maxLength={512}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={add.busy || props.full || !name.trim() || !url.trim()}
        >
          Add
        </button>
      </div>
      {props.full && <span className="subtle small">An account has at most 10 channels.</span>}
      {add.error !== null && (
        <p className="error" role="alert">
          Could not add it: {why(add.error)}.
        </p>
      )}
    </form>
  );
}
