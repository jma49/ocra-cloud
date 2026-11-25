import { type SubmitEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type AutoReviewRepoView,
  type BulkEnrollResult,
  type BulkEnrollView,
  type EnrollRefusal,
  MAX_BULK_ENROLL,
  MAX_BULK_ENROLL_GITLAB,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { SecretOnce } from "../notifications/deliveries-drawer.js";
import { PLATFORM_NAME } from "../platform-names.js";
import { useAction } from "../ui.js";
import { type ListedRepos, offeredRepos } from "./add-repo.js";

// Adding several of the repositories a platform lists for the user at once.
// The server takes a few per request, so a larger choice goes in parts, and
// each repository's own outcome is shown. A GitLab project whose webhook
// ocra could not add itself answers its secret, shown only then.

type Platform = "github" | "gitlab";

const WORDS: Record<
  Platform,
  { each: number; one: string; many: string; reach: string; opens: string; unreached: string }
> = {
  github: {
    each: MAX_BULK_ENROLL,
    one: "repository",
    many: "repositories",
    reach: "the GitHub App reaches",
    opens: "pull request",
    unreached: "the GitHub App does not reach it",
  },
  gitlab: {
    each: MAX_BULK_ENROLL_GITLAB,
    one: "project",
    many: "projects",
    reach: "you reach on GitLab",
    opens: "merge request",
    unreached: "you do not reach it on GitLab",
  },
};

const REFUSED: Record<Exclude<EnrollRefusal, "not_found">, string> = {
  taken: "another account reviews it",
  limit: "this account reviews as many as it may",
};

const chunks = (names: readonly string[], each: number) =>
  Array.from({ length: Math.ceil(names.length / each) }, (_, i) =>
    names.slice(i * each, (i + 1) * each),
  );

export function BulkEnroll(props: {
  platform: Platform;
  listed: ListedRepos | undefined;
  enrolled: readonly AutoReviewRepoView[];
  onAdded: () => void;
}) {
  const words = WORDS[props.platform];
  const name = PLATFORM_NAME[props.platform];
  const count = (n: number) => `${n} ${n === 1 ? words.one : words.many}`;
  const offered = offeredRepos(props.listed, props.platform, props.enrolled);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [automatic, setAutomatic] = useState(false);
  const [results, setResults] = useState<BulkEnrollResult[] | null>(null);
  const names = offered.filter((n) => picked.has(n));
  const enroll = useAction(async () => {
    const done: BulkEnrollResult[] = [];
    try {
      for (const fullNames of chunks(names, words.each)) {
        const part = await api<BulkEnrollView>("/auto-review/repos/bulk", {
          method: "POST",
          body: JSON.stringify({ platform: props.platform, fullNames, automatic }),
        });
        done.push(...part.results);
      }
    } finally {
      // A part that failed leaves the earlier parts enrolled: show them.
      setResults(done);
      if (done.length > 0) props.onAdded();
    }
    return done;
  });
  if (offered.length < 2 && results === null) return null;
  const toggle = (name: string) => {
    const next = new Set(picked);
    if (!next.delete(name)) next.add(name);
    setPicked(next);
  };
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if ((await enroll.run()) !== undefined) setPicked(new Set());
  };
  const refused = (results ?? []).filter((r) => r.outcome === "refused");
  const added = (results ?? []).filter((r) => r.outcome === "enrolled").length;
  const already = (results ?? []).filter((r) => r.outcome === "already").length;
  const byHand = (results ?? []).flatMap((r) =>
    r.outcome === "enrolled" && r.webhook && !r.webhook.managed
      ? [{ fullName: r.fullName, ...r.webhook }]
      : [],
  );
  return (
    <form
      className="card card-pad stack add-form"
      onSubmit={submit}
      aria-label={`Add several from ${name}`}
    >
      <div className="row-gap">
        <div className="grow">
          <h2 className="card-title">Add several from {name}</h2>
          <span className="subtle small">
            {count(offered.length)} {words.reach} {offered.length === 1 ? "is" : "are"} not under
            review.
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Close" : "Choose"}
        </Button>
      </div>
      {open && offered.length > 0 && (
        <>
          <div className="row-gap enroll-pick">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setPicked(names.length === offered.length ? new Set() : new Set(offered))
              }
            >
              {names.length === offered.length ? "Clear" : "Select all"}
            </Button>
            <span className="subtle small">{names.length} chosen</span>
          </div>
          <fieldset className="enroll-list" aria-label={`${name} ${words.many} to add`}>
            {offered.map((name) => (
              <label key={name} className="check">
                <input type="checkbox" checked={picked.has(name)} onChange={() => toggle(name)} />
                {name}
              </label>
            ))}
          </fieldset>
          <label className="check small">
            <input
              type="checkbox"
              checked={automatic}
              onChange={(e) => setAutomatic(e.target.checked)}
            />
            Review each {words.opens} as it opens (otherwise only when asked)
          </label>
          <div>
            <Button type="submit" size="sm" loading={enroll.busy} disabled={names.length === 0}>
              {names.length === 0 ? "Add" : `Add ${count(names.length)}`}
            </Button>
          </div>
        </>
      )}
      {results !== null && results.length > 0 && (
        <div className="stack-tight" role="status">
          <span>
            Added {count(added)}
            {already > 0 && `; ${already} already under review`}
            {refused.length > 0 && `; ${refused.length} not added`}.
          </span>
          {refused.length > 0 && (
            <ul className="enroll-refused small">
              {refused.map((r) => (
                <li key={r.fullName}>
                  <span className="strong">{r.fullName}</span>:{" "}
                  {r.outcome === "refused" &&
                    (r.reason === "not_found" ? words.unreached : REFUSED[r.reason])}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {byHand.length > 0 && (
        <section className="stack" aria-label="Webhooks to add by hand">
          <p className="note m-0" role="status">
            <span>
              ocra could not add the webhook of {count(byHand.length)} itself. In each one, open
              Settings, Webhooks, and add the address below with the project's own secret token.
              Turn on Merge request events, Comments and Pipeline events.
            </span>
          </p>
          <label className="stack-tight">
            <span className="subtle small">Address</span>
            <input
              className="input mono"
              readOnly
              value={byHand[0]?.url ?? ""}
              aria-label="Webhook address"
            />
          </label>
          {byHand.map((h) => (
            <div key={h.fullName} className="stack-tight">
              <span className="small">
                <span>{h.fullName}</span>
                {h.problem && <span className="subtle">: {h.problem}</span>}
              </span>
              {h.secret && <SecretOnce secret={h.secret} what="Secret token" />}
            </div>
          ))}
        </section>
      )}
      {enroll.error !== null && (
        <p className="error m-0" role="alert">
          Could not add {results && results.length > 0 ? "the rest" : "them"}: {why(enroll.error)}.
        </p>
      )}
    </form>
  );
}
