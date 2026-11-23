import BellOff from "lucide-react/icons/bell-off";
import ChevronRight from "lucide-react/icons/chevron-right";
import Ellipsis from "lucide-react/icons/ellipsis";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import {
  type CodePlatformKind,
  NOTIFY_KINDS,
  NOTIFY_WHEN,
  type NotifyChannelAdded,
  type NotifyChannelsView,
  type NotifyChannelView,
  type NotifyKind,
  type NotifyWhen,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useCached } from "../cache.js";
import { ago } from "../format.js";
import { DeliveriesDrawer, SecretOnce } from "../notifications/deliveries-drawer.js";
import { EventsMenu } from "../notifications/events-menu.js";
import {
  type ReminderChange,
  RemindersDrawer,
  reminderSummary,
} from "../notifications/reminders-drawer.js";
import { ReportSlot } from "../notifications/report-slot.js";
import { StackTable } from "../stack-table.js";
import { ActionError, EmptyState, LoadError, Loading, PageHead, useAction } from "../ui.js";

// The chats and email addresses that hear about reviews: a Slack or WeCom
// incoming webhook, or an address confirmed by the link mailed to it, each
// with which reviews it hears about and whether it gets the daily digest and
// the weekly report, whose UTC day and hour the account picks, which events
// of the user's own pull requests it hears about, and its reminders.
// The address is sent once and never shown again.

const KIND_LABEL: Record<NotifyKind, string> = {
  slack: "Slack",
  wecom: "WeCom",
  email: "Email",
  webhook: "Webhook",
};
const WHEN_LABEL: Record<NotifyWhen, string> = {
  blocking: "Blocking reviews",
  findings: "Reviews with findings",
  every: "Every review",
};
const PLACEHOLDER: Record<NotifyKind, string> = {
  slack: "https://hooks.slack.com/services/…",
  wecom: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…",
  email: "you@example.com",
  webhook: "https://example.com/ocra-webhook",
};
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

type ChannelEdit = Partial<Pick<NotifyChannelView, "when" | "digest" | "weekly" | "events">>;

export function Notifications(props: { platforms: readonly CodePlatformKind[] }) {
  const {
    data,
    error,
    reload,
    change: shown,
  } = useCached("/notifications/channels", () =>
    api<NotifyChannelsView>("/notifications/channels"),
  );
  const [tested, setTested] = useState<{ id: string; delivered: boolean } | null>(null);
  const [linkSent, setLinkSent] = useState<string | null>(null);
  const [reminding, setReminding] = useState<NotifyChannelView | null>(null);
  const [inspecting, setInspecting] = useState<NotifyChannelView | null>(null);
  const change = useAction((id: string, body: ChannelEdit | ReminderChange) =>
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
  // A switch or choice shows its new value at once; a refused save puts the old one back.
  const set = async (id: string, edit: ChannelEdit) => {
    const undo = shown((d) => ({
      ...d,
      channels: d.channels.map((c) => (c.id === id ? { ...c, ...edit } : c)),
    }));
    if ((await change.run(id, edit)) === undefined) undo();
    else reload();
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
        sub={
          data?.email
            ? "Send review results, a daily digest and a weekly report to a Slack or WeCom chat, a webhook or an email address."
            : "Send review results, a daily digest and a weekly report to a Slack or WeCom chat or a webhook."
        }
      />
      {linkSent && (
        <p className="note ok" role="status">
          A link to confirm {linkSent} is on its way. Nothing is sent there until it is opened.
        </p>
      )}
      <AddChannel
        onAdded={(confirming) => {
          setLinkSent(confirming);
          reload();
        }}
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
        <div className="card">
          <EmptyState icon={BellOff} title="No channels yet">
            Add one above to hear when a review lands. Each address is kept encrypted and never
            shown again{data.email ? "; an email address first gets a link to confirm it" : ""}.
          </EmptyState>
        </div>
      ) : (
        <div className="card">
          <StackTable>
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Sends</th>
                  <th>Digest</th>
                  <th>Weekly</th>
                  <th>My pull requests</th>
                  <th>Reminders</th>
                  <th>Last message</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.channels.map((c) => (
                  <tr key={c.id}>
                    <td className="channel-name">
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
                        onChange={(e) => set(c.id, { when: e.target.value as NotifyWhen })}
                      >
                        {NOTIFY_WHEN.map((w) => (
                          <option key={w} value={w}>
                            {WHEN_LABEL[w]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className="cell-name" aria-hidden="true">
                        Digest
                      </span>
                      {c.kind === "webhook" ? (
                        <span className="subtle small">Not sent</span>
                      ) : (
                        <Switch
                          aria-label={`Daily digest to ${c.name}`}
                          checked={c.digest}
                          disabled={change.busy}
                          onCheckedChange={() => set(c.id, { digest: !c.digest })}
                        />
                      )}
                    </td>
                    <td>
                      <span className="cell-name" aria-hidden="true">
                        Weekly
                      </span>
                      {c.kind === "webhook" ? (
                        <span className="subtle small">Not sent</span>
                      ) : (
                        <Switch
                          aria-label={`Weekly report to ${c.name}`}
                          checked={c.weekly}
                          disabled={change.busy}
                          onCheckedChange={() => set(c.id, { weekly: !c.weekly })}
                        />
                      )}
                    </td>
                    <td>
                      <span className="cell-name" aria-hidden="true">
                        My pull requests
                      </span>
                      <EventsMenu
                        channel={c.name}
                        events={c.events}
                        quietHours={c.quietHours}
                        disabled={change.busy}
                        change={(events) => set(c.id, { events })}
                      />
                    </td>
                    <td>
                      <span className="cell-name" aria-hidden="true">
                        Reminders
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Reminders to ${c.name}: ${reminderSummary(c)}`}
                        onClick={() => setReminding(c)}
                      >
                        {reminderSummary(c)}
                      </Button>
                    </td>
                    <td>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="channel-status"
                        onClick={() => setInspecting(c)}
                      >
                        {c.confirmed ? (
                          <LastSent c={c} tested={tested?.id === c.id ? tested.delivered : null} />
                        ) : (
                          <span className="badge badge-warn">Awaiting confirmation</span>
                        )}
                        <span className="sr-only">, deliveries to {c.name}</span>
                        <ChevronRight aria-hidden="true" />
                      </Button>
                    </td>
                    <td className="num">
                      <Menu>
                        <MenuTrigger
                          render={<Button type="button" variant="ghost" size="icon-sm" />}
                          aria-label={`Actions for ${c.name}`}
                        >
                          <Ellipsis aria-hidden="true" />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          {c.confirmed ? (
                            <MenuItem disabled={test.busy} onClick={() => sendTest(c.id)}>
                              Send test
                            </MenuItem>
                          ) : (
                            <MenuItem
                              disabled={resend.busy}
                              onClick={async () => {
                                if ((await resend.run(c.id)) === undefined) return;
                                setLinkSent(c.name);
                                reload();
                              }}
                            >
                              Send link again
                            </MenuItem>
                          )}
                          <MenuItem
                            variant="destructive"
                            disabled={remove.busy}
                            onClick={() => after(remove.run(c.id))}
                          >
                            Remove
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StackTable>
          {data.channels.some((c) => c.events.length > 0) && (
            <p className="subtle small card-pad m-0">
              A channel that hears of ocra's critical findings in your pull requests gets that
              message in place of the review's announcement.
              {props.platforms.includes("gitlab") &&
                " If GitLab's events do not arrive, connect GitLab again under Repositories: an older connection does not say who you are."}
            </p>
          )}
        </div>
      )}
      <ReportSlot />
      {inspecting && <DeliveriesDrawer channel={inspecting} onClose={() => setInspecting(null)} />}
      {reminding && (
        <RemindersDrawer
          channel={reminding}
          onSave={async (body) => {
            await api(`/notifications/channels/${reminding.id}`, json("PATCH", body));
            reload();
          }}
          onClose={() => setReminding(null)}
        />
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

function AddChannel(props: {
  /** Called with the channel's name when a confirmation link went to it. */
  onAdded: (confirming: string | null) => void;
  full: boolean;
  email: boolean;
}) {
  const [kind, setKind] = useState<NotifyKind>("slack");
  const [name, setName] = useState("");
  const [when, setWhen] = useState<NotifyWhen>("blocking");
  const [url, setUrl] = useState("");
  const [digest, setDigest] = useState(false);
  const [weekly, setWeekly] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const hook = kind === "webhook";
  const add = useAction(() =>
    api<NotifyChannelAdded>(
      "/notifications/channels",
      json("POST", {
        kind,
        name: name.trim(),
        when,
        digest: digest && !hook,
        weekly: weekly && !hook,
        ...(kind === "email" ? { address: url.trim() } : { url }),
      }),
    ),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const added = await add.run();
    if (added === undefined) return;
    setName("");
    setUrl("");
    setSecret(added.secret ?? null);
    props.onAdded(added.confirmationSent ? name.trim() : null);
  };
  return (
    <form className="card card-pad stack add-form" onSubmit={submit}>
      <div className="strong">Add a channel</div>
      <div className="add-fields">
        <select
          className="input"
          aria-label="Where"
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
          placeholder="Name, e.g. #reviews"
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
          maxLength={hook ? 2048 : 512}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit" disabled={add.busy || props.full || !name.trim() || !url.trim()}>
          Add
        </Button>
      </div>
      <div className="add-extras" hidden={hook}>
        <label className="check small">
          <input type="checkbox" checked={digest} onChange={(e) => setDigest(e.target.checked)} />
          Daily digest of yesterday's reviews
        </label>
        <label className="check small">
          <input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} />
          Weekly report
        </label>
      </div>
      {kind === "email" && (
        <span className="subtle small">
          The address gets a link to confirm it first; nothing else is sent until it is opened.
        </span>
      )}
      {hook && (
        <span className="subtle small">
          Each event is posted as signed JSON to an https address of a public host.
        </span>
      )}
      {secret !== null && <SecretOnce secret={secret} what="Signing secret" />}
      {props.full && <span className="subtle small">An account has at most 10 channels.</span>}
      {add.error !== null && (
        <p className="error" role="alert">
          Could not add it: {why(add.error)}.
        </p>
      )}
    </form>
  );
}
