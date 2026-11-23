import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MAX_FIRST_REVIEW_HOURS,
  MAX_MERGE_DAYS,
  type ReviewTargets,
  type ReviewTargetsView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { PlatformMark } from "../platform-mark.js";
import { LoadError, Loading, useAction, useLoad } from "../ui.js";

// How fast the enrolled repositories' pull requests should get a first
// review and merge: the account's default, and a repository's own in its
// place. Insights lists the pull requests near or past them.

type Repo = ReviewTargetsView["repos"][number];

const text = (t: ReviewTargets) => {
  const parts = [
    t.firstReviewHours !== null && `first review in ${t.firstReviewHours}h`,
    t.mergeDays !== null && `merged in ${t.mergeDays}d`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "no target";
};

// An empty field sets no target of that kind.
const parsed = (s: string) => (s.trim() === "" ? null : Number(s));
const shown = (n: number | null) => (n === null ? "" : String(n));

function TargetsForm(props: {
  name: string;
  value: ReviewTargets;
  save: (t: ReviewTargets) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [hours, setHours] = useState(shown(props.value.firstReviewHours));
  const [days, setDays] = useState(shown(props.value.mergeDays));
  const save = useAction(props.save);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.run({ firstReviewHours: parsed(hours), mergeDays: parsed(days) });
  };
  const same =
    parsed(hours) === props.value.firstReviewHours && parsed(days) === props.value.mergeDays;
  return (
    <form className="stack-tight" onSubmit={submit}>
      <div className="target-fields">
        <label className="small">
          First review within{" "}
          <input
            className="input target-n"
            type="number"
            min={1}
            max={MAX_FIRST_REVIEW_HOURS}
            step={1}
            placeholder="–"
            aria-label={`${props.name}: hours to the first review`}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />{" "}
          hours
        </label>
        <label className="small">
          Merged within{" "}
          <input
            className="input target-n"
            type="number"
            min={1}
            max={MAX_MERGE_DAYS}
            step={1}
            placeholder="–"
            aria-label={`${props.name}: days to merge`}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />{" "}
          days
        </label>
        <Button type="submit" size="sm" loading={save.busy} disabled={same && !props.onCancel}>
          Save
        </Button>
        {props.onCancel && (
          <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {save.error !== null && (
        <p className="error small m-0" role="alert">
          Could not save it: {why(save.error)}.
        </p>
      )}
    </form>
  );
}

export function ReviewTargetsCard() {
  const { data, error, reload } = useLoad(() => api<ReviewTargetsView>("/review-targets"));
  const [editing, setEditing] = useState<string | null>(null);
  const put = (path: string) => async (t: ReviewTargets) => {
    await api(`/review-targets/${path}`, { method: "PUT", body: JSON.stringify(t) });
    setEditing(null);
    reload();
  };
  const reset = useAction(async (id: string) => {
    await api(`/review-targets/repos/${encodeURIComponent(id)}`, { method: "DELETE" });
    reload();
  });
  return (
    <section className="section card" id="review-targets" aria-label="Review targets">
      <div className="card-head">
        <h2>Review targets</h2>
      </div>
      <div className="card-pad stack">
        <p className="muted small m-0">
          How soon a pull request that is ready should get its first review, and merge. Insights
          lists the ones near or past a target, and a notification channel can be told. An empty
          field sets no target.
        </p>
        {error && !data ? (
          <LoadError what="the review targets" error={error} retry={reload} inCard />
        ) : !data ? (
          <Loading what="the review targets" />
        ) : (
          <>
            <div className="stack-tight">
              <span className="strong">Default</span>
              {/* A saved default remounts the form on what the server holds. */}
              <TargetsForm
                key={text(data.default)}
                name="Default"
                value={data.default}
                save={put("default")}
              />
            </div>
            {reset.error !== null && (
              <p className="error small m-0" role="alert">
                Could not reset it: {why(reset.error)}.
              </p>
            )}
            {data.repos.length > 0 && (
              <ul className="target-repos">
                {data.repos.map((r) => (
                  <RepoRow
                    key={r.reviewRepoId}
                    repo={r}
                    editing={editing === r.reviewRepoId}
                    fallback={data.default}
                    onEdit={(on) => setEditing(on ? r.reviewRepoId : null)}
                    save={put(`repos/${encodeURIComponent(r.reviewRepoId)}`)}
                    reset={() => reset.run(r.reviewRepoId)}
                    busy={reset.busy}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function RepoRow(props: {
  repo: Repo;
  editing: boolean;
  fallback: ReviewTargets;
  onEdit: (on: boolean) => void;
  save: (t: ReviewTargets) => Promise<unknown>;
  reset: () => void;
  busy: boolean;
}) {
  const { repo } = props;
  return (
    <li>
      <div className="row-gap">
        <span className="mono with-mark grow">
          <PlatformMark platform={repo.platform} size={14} />
          {repo.fullName}
        </span>
        <span className="muted small">
          {repo.targets ? `Its own: ${text(repo.targets)}` : "Default"}
        </span>
        {!props.editing && (
          <Button variant="outline" size="sm" onClick={() => props.onEdit(true)}>
            {repo.targets ? "Change" : "Set its own"}
          </Button>
        )}
        {repo.targets && !props.editing && (
          <Button variant="outline" size="sm" disabled={props.busy} onClick={props.reset}>
            Use default
          </Button>
        )}
      </div>
      {props.editing && (
        <TargetsForm
          name={repo.fullName}
          value={repo.targets ?? props.fallback}
          save={props.save}
          onCancel={() => props.onEdit(false)}
        />
      )}
    </li>
  );
}
