import { Button } from "@/components/ui/button";
import { PLATFORM_NAME } from "../platform-names.js";
import type { Added } from "./add-repo.js";

// What is left to do on the platform after a repository is added. ocra adds a
// GitLab project's webhook itself when its token may; otherwise the address
// and the secret, shown only now, are added by hand.

export function Hook(props: { added: Added; onDone: () => void }) {
  const { repo, webhook } = props.added;
  const done = (
    <div>
      <Button type="button" variant="outline" onClick={props.onDone}>
        Done
      </Button>
    </div>
  );
  if (webhook.managed) {
    return (
      <section className="card card-pad stack hook-card" aria-label="Webhook">
        <h2 className="card-title">Webhook added</h2>
        <p className="m-0">
          ocra added its webhook to <span className="mono">{repo.fullName}</span> and removes it
          when you remove the project. Nothing is left to do on GitLab.
        </p>
        {done}
      </section>
    );
  }
  return (
    <section className="card card-pad stack hook-card" aria-label="Webhook">
      <h2 className="card-title">One step on {PLATFORM_NAME[repo.platform]}</h2>
      {webhook.problem && (
        <p className="note m-0" role="status">
          ocra could not add the webhook itself: {webhook.problem}.
        </p>
      )}
      {repo.platform === "gitlab" ? (
        <p className="m-0">
          In <span className="mono">{repo.fullName}</span>, open Settings, Webhooks, and add this
          address with the secret token below. Turn on Merge request events, Comments and Pipeline
          events. The secret is shown only now.
        </p>
      ) : (
        <p className="m-0">
          Install this server's GitHub App on <span className="mono">{repo.fullName}</span>. The
          App's webhook sends pull request events to this address.
        </p>
      )}
      <label className="stack-tight">
        <span className="subtle small">Address</span>
        <input className="input mono" readOnly value={webhook.url} aria-label="Webhook address" />
      </label>
      {webhook.secret && (
        <label className="stack-tight">
          <span className="subtle small">Secret token</span>
          <input className="input mono" readOnly value={webhook.secret} aria-label="Secret token" />
        </label>
      )}
      {done}
    </section>
  );
}
