import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type AutoReviewRepoView,
  type BulkEnrollResult,
  type BulkEnrollView,
  type EnrollRefusal,
  MAX_BULK_ENROLL,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useAction } from "../ui.js";
import { type ListedRepos, offeredRepos } from "./add-repo.js";

// Adding several of the repositories the GitHub App reaches at once. The
// server takes a few per request, so a larger choice goes in parts, and each
// repository's own outcome is shown.

const REFUSED: Record<EnrollRefusal, string> = {
  not_found: "the GitHub App does not reach it",
  taken: "another account reviews it",
  limit: "this account reviews as many as it may",
};

const chunks = (names: readonly string[]) =>
  Array.from({ length: Math.ceil(names.length / MAX_BULK_ENROLL) }, (_, i) =>
    names.slice(i * MAX_BULK_ENROLL, (i + 1) * MAX_BULK_ENROLL),
  );

const count = (n: number) => `${n} ${n === 1 ? "repository" : "repositories"}`;

export function BulkEnroll(props: {
  listed: ListedRepos | undefined;
  enrolled: readonly AutoReviewRepoView[];
  onAdded: () => void;
}) {
  const offered = offeredRepos(props.listed, "github", props.enrolled);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [automatic, setAutomatic] = useState(false);
  const [results, setResults] = useState<BulkEnrollResult[] | null>(null);
  const names = offered.filter((n) => picked.has(n));
  const enroll = useAction(async () => {
    const done: BulkEnrollResult[] = [];
    try {
      for (const fullNames of chunks(names)) {
        const part = await api<BulkEnrollView>("/auto-review/repos/bulk", {
          method: "POST",
          body: JSON.stringify({ fullNames, automatic }),
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
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ((await enroll.run()) !== undefined) setPicked(new Set());
  };
  const refused = (results ?? []).filter((r) => r.outcome === "refused");
  const added = (results ?? []).filter((r) => r.outcome === "enrolled").length;
  const already = (results ?? []).filter((r) => r.outcome === "already").length;
  return (
    <form className="card card-pad stack add-form" onSubmit={submit} aria-label="Add several">
      <div className="row-gap">
        <div className="grow">
          <h2 className="card-title">Add several from GitHub</h2>
          <span className="subtle small">
            {count(offered.length)} the GitHub App reaches {offered.length === 1 ? "is" : "are"} not
            under review.
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
          <fieldset className="enroll-list" aria-label="Repositories to add">
            {offered.map((name) => (
              <label key={name} className="check mono">
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
            Review each pull request as it opens (otherwise only when asked)
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
                  <span className="mono">{r.fullName}</span>:{" "}
                  {r.outcome === "refused" && REFUSED[r.reason]}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {enroll.error !== null && (
        <p className="error m-0" role="alert">
          Could not add {results && results.length > 0 ? "the rest" : "them"}: {why(enroll.error)}.
        </p>
      )}
    </form>
  );
}
