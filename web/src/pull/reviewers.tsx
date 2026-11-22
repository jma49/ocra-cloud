import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CodePlatformKind,
  PullReviewersView,
  RequestReviewersView,
  ReviewerReason,
  SuggestedReviewer,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useAction, useLoad } from "../ui.js";
import { OUTCOME } from "./outcome.js";

// Reviewers suggested for the pull request: the changed files' code owners
// and the repository's recent reviewers, each with the reviews they are
// asked for now; one is asked from here, as the user.

type Ref = { platform: CodePlatformKind; repo: string; number: number };

const REASON: Record<ReviewerReason, string> = {
  codeowner: "code owner",
  recent_reviewer: "reviews here",
};

const detail = (s: SuggestedReviewer, days: number) =>
  [
    s.ownedFiles > 0 ? `owns ${s.ownedFiles} changed ${s.ownedFiles === 1 ? "file" : "files"}` : "",
    s.recentReviews > 0 ? `${s.recentReviews} reviews in ${days} days` : "",
    s.load === null ? "" : `${s.load} open requests`,
  ]
    .filter(Boolean)
    .join(" · ");

export function ReviewersPanel(props: { pull: Ref }) {
  const { platform, repo, number } = props.pull;
  const query = new URLSearchParams({ platform, repo, number: String(number) }).toString();
  const { data, reload } = useLoad(
    () => api<PullReviewersView>(`/pulls/reviewers?${query}`),
    [query],
  );
  const ask = useAction((login: string) =>
    api<RequestReviewersView>("/pulls/reviewers", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, logins: [login] }),
    }),
  );
  const [refused, setRefused] = useState<RequestReviewersView["outcome"] | null>(null);
  if (!data || (data.suggestions.length === 0 && data.owners.length === 0)) return null;
  const send = async (login: string) => {
    const sent = await ask.run(login);
    setRefused(sent && sent.outcome !== "done" ? sent.outcome : null);
    if (sent?.outcome === "done") reload();
  };
  const teams = data.owners.filter((o) => o.kind !== "user");
  return (
    <section className="card card-pad stack" aria-label="Suggested reviewers">
      <div className="strong">Suggested reviewers</div>
      <ul className="stack">
        {data.suggestions.map((s) => (
          <li key={s.login} className="stack">
            <span>
              <span className="mono">{s.login}</span>{" "}
              <span className="subtle small">{s.reasons.map((r) => REASON[r]).join(", ")}</span>
            </span>
            <span className="subtle small">{detail(s, data.historyDays)}</span>
            {s.alreadyRequested ? (
              <span className="subtle small">Asked for a review</span>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={ask.busy}
                onClick={() => send(s.login)}
                aria-label={`Ask ${s.login} for a review`}
              >
                Ask for review
              </Button>
            )}
          </li>
        ))}
      </ul>
      {teams.length > 0 && (
        <p className="subtle small">Also owned by {teams.map((t) => t.owner).join(", ")}.</p>
      )}
      {data.history === "not_enrolled" && (
        <p className="subtle small">
          Review history is kept only for repositories enrolled for reviews.
        </p>
      )}
      {refused && (
        <p className="error small" role="alert">
          {OUTCOME[refused]}
        </p>
      )}
      {ask.error !== null && (
        <p className="error" role="alert">
          Could not ask for a review: {why(ask.error)}.
        </p>
      )}
    </section>
  );
}
