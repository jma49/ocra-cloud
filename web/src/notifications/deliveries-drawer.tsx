import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  NotifyChannelView,
  NotifyDeliveriesView,
  NotifyDeliveryError,
  NotifyDeliveryEvent,
  NotifyDeliveryView,
  WebhookSecretView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useRead } from "../cache.js";
import { Drawer } from "../drawer.js";
import { ago } from "../format.js";
import { WEBHOOK_DOCS } from "../site.js";
import { useToast } from "../toast.js";
import { ActionError, LoadError, Loading, useAction } from "../ui.js";

// A channel up close: how its last deliveries went, and a webhook's signing
// secret, which can be replaced but never read again.

const STATE: Record<NotifyDeliveryView["state"], { label: string; tone: string }> = {
  delivered: { label: "Delivered", tone: "badge badge-ok" },
  pending: { label: "Will retry", tone: "badge badge-warn" },
  failed: { label: "Failed", tone: "badge badge-err" },
};
const ERROR: Record<NotifyDeliveryError, string> = {
  refused: "Address not allowed",
  redirect: "Answered with a redirect",
  timeout: "Timed out",
  network: "Could not connect",
  status: "No 2xx answer",
  rejected: "Refused by the chat",
  unwanted: "No longer wanted by this channel",
};
// A webhook's endpoint reads the event's id, so its list keeps it; people read these.
const EVENT: Record<NotifyDeliveryEvent, string> = {
  review_completed: "Review finished",
  automation_ran: "Automation rule",
  ping: "Test message",
  digest: "Daily digest",
  weekly_report: "Weekly report",
  held_notices: "Notices held in quiet hours",
  spend_limit: "Spend limit warning",
  review_requested: "Review requested",
  pull_reviewed: "Pull request reviewed",
  pull_closed: "Pull request merged or closed",
  checks_failed: "Checks failed",
  review_blocking: "Critical finding",
  merge_when_ready: "Merge when ready",
  stack_merge: "Stack merge",
  pull_commented: "Comment",
  mentioned: "Mention",
  thread_replied: "Thread reply",
  pull_at_risk: "Review target at risk",
  review_waiting: "Reminder: review waiting",
  pull_waiting: "Reminder: no review yet",
};

/** When a pending delivery is tried again: "in 4m", or "soon" once it is due. */
function nextTry(iso: string): string {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s < 60) return "soon";
  return s < 3600 ? `in ${Math.ceil(s / 60)}m` : `in ${Math.ceil(s / 3600)}h`;
}

const answer = (d: NotifyDeliveryView, email: boolean) =>
  d.error && d.error !== "status"
    ? ERROR[d.error]
    : d.status
      ? `${email ? "SMTP" : "HTTP"} ${d.status}`
      : d.error
        ? "No answer"
        : "Accepted";

/** A secret the server answers once: shown with Copy until the page lets go of it. */
export function SecretOnce(props: { secret: string; what: string }) {
  const toast = useToast();
  return (
    <div className="stack-tight" role="status">
      <span className="small">{props.what}, shown only now:</span>
      <div className="token-secret">
        <code className="mono">{props.secret}</code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(props.secret);
            toast("Secret copied");
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

/** A webhook's signing secret: replaced, never shown again. */
function SigningSecret(props: { base: string }) {
  const { base } = props;
  const [confirming, setConfirming] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const rotate = useAction(() => api<WebhookSecretView>(`${base}/secret`, { method: "POST" }));
  const replace = async () => {
    const made = await rotate.run();
    if (made === undefined) return;
    setSecret(made.secret);
    setConfirming(false);
  };
  return (
    <section className="stack-tight" aria-label="Signing secret">
      <div className="strong">Signing secret</div>
      <p className="muted small m-0">
        Each delivery is signed with it.{" "}
        <a href={WEBHOOK_DOCS} target="_blank" rel="noreferrer">
          Verify the signature
        </a>{" "}
        before trusting a body.
      </p>
      {rotate.error !== null && <ActionError what="replace the secret" error={rotate.error} />}
      {secret !== null && <SecretOnce secret={secret} what="New secret" />}
      <div className="row-gap">
        {confirming ? (
          <>
            <Button type="button" variant="destructive" disabled={rotate.busy} onClick={replace}>
              Confirm: replace secret
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <span className="muted small">The old one stops signing at once.</span>
          </>
        ) : (
          <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
            Replace secret
          </Button>
        )}
      </div>
    </section>
  );
}

export function DeliveriesDrawer(props: { channel: NotifyChannelView; onClose: () => void }) {
  const { channel: c } = props;
  const base = `/notifications/channels/${c.id}`;
  const { data, error, reload, loading } = useRead<NotifyDeliveriesView>(`${base}/deliveries`);

  return (
    <Drawer
      title={c.kind === "webhook" ? `Webhook ${c.name}` : `Deliveries to ${c.name}`}
      heading={c.name}
      onClose={props.onClose}
    >
      {c.kind === "webhook" && <SigningSecret base={base} />}

      <section className="stack-tight channel-deliveries" aria-label="Recent deliveries">
        <div className="row-gap channel-deliveries-head">
          <div className="strong grow">Recent deliveries</div>
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={reload}>
            Refresh
          </Button>
        </div>
        {error && !data ? (
          <LoadError what="the deliveries" error={error} retry={reload} inCard />
        ) : !data ? (
          <Loading what="deliveries" inCard />
        ) : data.deliveries.length === 0 ? (
          <p className="subtle small m-0">
            {c.confirmed
              ? "Nothing sent yet. Send a test from the channel's row."
              : "Nothing is sent until the address is confirmed."}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Result</th>
                  <th>Answer</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className={c.kind === "webhook" ? "mono" : "text"}>
                      {c.kind === "webhook" ? d.event : EVENT[d.event]}
                    </td>
                    <td>
                      <span className={STATE[d.state].tone}>{STATE[d.state].label}</span>
                    </td>
                    <td className="text muted">
                      {answer(d, c.kind === "email")}
                      {d.latencyMs !== null && `, ${d.latencyMs} ms`}
                      {d.attempts > 1 && `, ${d.attempts} attempts`}
                      {d.state === "pending" && d.retryAt && `, next ${nextTry(d.retryAt)}`}
                    </td>
                    <td className="muted">{ago(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.deliveries.length > 0 && (
          <p className="subtle small m-0">The newest 20 are kept, without their bodies.</p>
        )}
      </section>
    </Drawer>
  );
}
