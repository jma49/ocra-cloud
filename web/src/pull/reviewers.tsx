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

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const detail = (s: SuggestedReviewer, days: number) =>
  [
    s.ownedFiles > 0 ? `owns ${count(s.ownedFiles, "changed file")}` : "",
    s.recentReviews > 0 ? `${count(s.recentReviews, "review")} in ${days} days` : "",
    s.load === null ? "" : `${count(s.load, "open request")}`,
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
  const [asking, setAsking] = useState<string | null>(null);
  if (!data || (data.suggestions.length === 0 && data.owners.length === 0)) return null;
  const send = async (login: string) => {
    setAsking(login);
    const sent = await ask.run(login);
    setRefused(sent && sent.outcome !== "done" ? sent.outcome : null);
    if (sent?.outcome === "done") reload();
  };
  const teams = data.owners.filter((o) => o.kind !== "user");
  return (
    <section className="card card-pad stack" aria-label="Suggested reviewers">
      <div className="strong">Suggested reviewers</div>
      <ul className="reviewer-list">
        {data.suggestions.map((s) => (
          <li key={s.login}>
            <div className="reviewer-who">
              <span className="mono strong">{s.login}</span>
              <span className="subtle small">{s.reasons.map((r) => REASON[r]).join(", ")}</span>
            </div>
            {s.alreadyRequested ? (
              <span className="badge">Asked</span>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={ask.busy}
                loading={ask.busy && asking === s.login}
                onClick={() => send(s.login)}
                aria-label={`Ask ${s.login} for a review`}
              >
                Ask
              </Button>
            )}
            <span className="reviewer-detail subtle small">{detail(s, data.historyDays)}</span>
          </li>
        ))}
      </ul>
      {teams.length > 0 && (
        <p className="subtle small m-0">Also owned by {teams.map((t) => t.owner).join(", ")}.</p>
      )}
      {data.history === "not_enrolled" && (
        <p className="subtle small m-0">
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
