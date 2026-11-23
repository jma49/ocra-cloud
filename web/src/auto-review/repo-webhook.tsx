import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  AutoReviewRepoView,
  AutoReviewWebhookSecretView,
  AutoReviewWebhookView,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { SecretOnce } from "../notifications/deliveries-drawer.js";
import { useAction } from "../ui.js";

// A GitLab project's webhook: ocra adds it itself when asked, or answers a
// new secret for one added by hand. Either way the secret is new, so a hook
// that holds the old one stops being accepted.

/** Why GitLab did not take the hook: the server's words for it, else the usual ones. */
function refusal(e: unknown): string {
  if (e instanceof ApiError) {
    const issue = e.issues[0];
    if (issue) return issue.message;
    if (e.code === "upstream_unreachable") return "GitLab did not answer; try again";
    if (e.code === "stale") return "the secret was replaced at the same moment; try again";
  }
  return why(e);
}

export function RepoWebhook(props: { r: AutoReviewRepoView; onChanged: () => void }) {
  const { r } = props;
  const [secret, setSecret] = useState<string | null>(null);
  const setUp = useAction(() =>
    api<AutoReviewWebhookView>(`/auto-review/repos/${encodeURIComponent(r.id)}/webhook`, {
      method: "POST",
    }),
  );
  const run = async () => {
    const hook = await setUp.run();
    if (hook === undefined) return;
    setSecret(hook.secret ?? null);
    props.onChanged();
  };
  return (
    <section className="repo-token stack" aria-label={`Webhook of ${r.fullName}`}>
      <div className="strong">Webhook</div>
      <p className="muted small m-0">
        {r.webhookManaged
          ? "ocra added this project's webhook and removes it when you remove the project. Re-create it if GitLab no longer lists it."
          : "ocra did not add this project's webhook. It can add one now, which needs the Maintainer role in the project."}
      </p>
      <div>
        <Button type="button" variant="outline" size="sm" loading={setUp.busy} onClick={run}>
          {r.webhookManaged ? "Re-create webhook" : "Set up webhook"}
        </Button>
      </div>
      <span className="subtle small">
        The new webhook gets a new secret. One you added by hand keeps the old secret and is no
        longer accepted: remove it in GitLab.
      </span>
      {secret !== null && <SecretOnce secret={secret} what="The webhook's secret" />}
      {setUp.error !== null && (
        <p className="error m-0" role="alert">
          Could not add the webhook: {refusal(setUp.error)}.
        </p>
      )}
      <ByHand r={r} onChanged={props.onChanged} />
    </section>
  );
}

/** A new secret, with the address and the events, for a hook the person adds in GitLab. */
function ByHand(props: { r: AutoReviewRepoView; onChanged: () => void }) {
  const { r } = props;
  const [confirming, setConfirming] = useState(false);
  const [hook, setHook] = useState<AutoReviewWebhookSecretView | null>(null);
  const rotate = useAction(() =>
    api<AutoReviewWebhookSecretView>(
      `/auto-review/repos/${encodeURIComponent(r.id)}/webhook/secret`,
      { method: "POST" },
    ),
  );
  const make = async () => {
    const made = await rotate.run();
    if (made === undefined) return;
    setHook(made);
    setConfirming(false);
    props.onChanged();
  };
  return (
    <section className="stack-tight" aria-label={`Webhook of ${r.fullName} by hand`}>
      <div className="strong">Add it by hand</div>
      <p className="muted small m-0">
        Without the Maintainer role, add the webhook in GitLab yourself, under Settings, Webhooks,
        with a new secret from here.
      </p>
      <div className="row-gap">
        {confirming ? (
          <>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              loading={rotate.busy}
              onClick={make}
            >
              Confirm: new secret
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <span className="muted small">
              Any webhook that holds the old secret is no longer accepted.
            </span>
          </>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
            New secret
          </Button>
        )}
      </div>
      {hook !== null && (
        <div className="stack-tight" role="status">
          <label className="stack-tight">
            <span className="subtle small">Address</span>
            <input className="input mono" readOnly value={hook.url} aria-label="Webhook address" />
          </label>
          <span className="small">Turn on {hook.events.join(", ")}.</span>
          <SecretOnce secret={hook.secret} what="Secret token" />
        </div>
      )}
      {rotate.error !== null && (
        <p className="error m-0" role="alert">
          Could not make a new secret: {refusal(rotate.error)}.
        </p>
      )}
    </section>
  );
}
