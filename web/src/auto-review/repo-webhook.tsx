import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { AutoReviewRepoView, AutoReviewWebhookView } from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { SecretOnce } from "../notifications/deliveries-drawer.js";
import { useAction } from "../ui.js";

// A GitLab project's webhook: ocra adds it itself when asked, with a new
// secret each time, so a hook added by hand before stops being accepted.

/** Why GitLab did not take the hook: the server's words for it, else the usual ones. */
function refusal(e: unknown): string {
  if (e instanceof ApiError) {
    const issue = e.issues[0];
    if (issue) return issue.message;
    if (e.code === "upstream_unreachable") return "GitLab did not answer; try again";
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
    </section>
  );
}
