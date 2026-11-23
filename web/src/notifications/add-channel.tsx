import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  NOTIFY_KINDS,
  NOTIFY_WHEN,
  type NotifyChannelAdded,
  type NotifyKind,
  type NotifyWhen,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { useAction } from "../ui.js";
import { SecretOnce } from "./deliveries-drawer.js";
import { KIND_LABEL, WHEN_LABEL } from "./labels.js";

// A new channel: where it goes is sent once and never shown again. An email
// address and a Slack member confirm by a link first; a webhook answers its
// signing secret once.

type Where = {
  /** The body's field for where the channel goes. */
  field: "url" | "address" | "member";
  label: string;
  placeholder: string;
  name: string;
  hint?: string;
};
const HOOK = { field: "url", label: "Webhook address", name: "Name, e.g. #reviews" } as const;
const WHERE: Record<NotifyKind, Where> = {
  slack: { ...HOOK, placeholder: "https://hooks.slack.com/services/…" },
  wecom: { ...HOOK, placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" },
  webhook: {
    ...HOOK,
    name: "Name, e.g. Deploy bot",
    placeholder: "https://example.com/ocra-webhook",
    hint: "Each event is posted as signed JSON to an https address of a public host.",
  },
  email: {
    field: "address",
    label: "Email address",
    name: "Name, e.g. My inbox",
    placeholder: "you@example.com",
    hint: "The address gets a link to confirm it first; nothing else is sent until it is opened.",
  },
  slack_dm: {
    field: "member",
    label: "Slack member",
    name: "Name, e.g. My Slack",
    placeholder: "you@example.com or U012AB3CD",
    hint: "The member gets a direct message with a link to confirm first; nothing else is sent until it is opened.",
  },
};

/** Why an add was refused: the server's words for the field it refused, else the usual ones. */
function refusal(e: unknown, kind: NotifyKind): string {
  if (e instanceof ApiError) {
    const issue = e.issues[0];
    if (issue) return issue.message;
    if (kind === "slack_dm" && e.code === "upstream_unreachable") {
      return "Slack did not answer; try again";
    }
  }
  return why(e);
}

export function AddChannel(props: {
  /** Called with the channel's name when a confirmation link went to it. */
  onAdded: (confirming: string | null) => void;
  full: boolean;
  email: boolean;
  slack: boolean;
}) {
  const [kind, setKind] = useState<NotifyKind>("slack");
  const [name, setName] = useState("");
  const [when, setWhen] = useState<NotifyWhen>("blocking");
  const [where, setWhere] = useState("");
  const [digest, setDigest] = useState(false);
  const [weekly, setWeekly] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const hook = kind === "webhook";
  const to = WHERE[kind];
  const add = useAction(() =>
    api<NotifyChannelAdded>("/notifications/channels", {
      method: "POST",
      body: JSON.stringify({
        kind,
        name: name.trim(),
        when,
        digest: digest && !hook,
        weekly: weekly && !hook,
        [to.field]: to.field === "url" ? where : where.trim(),
      }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const added = await add.run();
    if (added === undefined) return;
    setName("");
    setWhere("");
    setSecret(added.secret ?? null);
    props.onAdded(added.confirmationSent ? name.trim() : null);
  };
  return (
    <form className="card card-pad stack add-form" onSubmit={submit}>
      <h2 className="card-title">Add a channel</h2>
      <div className="add-fields">
        <select
          className="input"
          aria-label="Where"
          value={kind}
          onChange={(e) => setKind(e.target.value as NotifyKind)}
        >
          {NOTIFY_KINDS.filter(
            (k) => (k !== "email" || props.email) && (k !== "slack_dm" || props.slack),
          ).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input
          className="input"
          aria-label="Name"
          placeholder={to.name}
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
          aria-label={to.label}
          placeholder={to.placeholder}
          maxLength={hook ? 2048 : 512}
          value={where}
          onChange={(e) => setWhere(e.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          disabled={add.busy || props.full || !name.trim() || !where.trim()}
        >
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
      {to.hint && <span className="subtle small">{to.hint}</span>}
      {secret !== null && <SecretOnce secret={secret} what="Signing secret" />}
      {props.full && <span className="subtle small">An account has at most 10 channels.</span>}
      {add.error !== null && (
        <p className="error" role="alert">
          Could not add it: {refusal(add.error, kind)}.
        </p>
      )}
    </form>
  );
}
