import Lightbulb from "lucide-react/icons/lightbulb";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  LearningChangeView,
  LearningProposalsView,
  LearningsView,
  LearningView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { AddGlyph } from "../glyphs.js";
import { LearningCard } from "../learnings/learning-card.js";
import { LearningForm } from "../learnings/learning-form.js";
import { ChangeOutcome } from "../learnings/outcome.js";
import { Proposals } from "../learnings/proposals.js";
import { type RepoChoice, useRepoChoice } from "../repo-choice.js";
import { ActionError, LoadError, Loading, PageHead, useAction, useLoad } from "../ui.js";

// A repository's learnings, read live from its default branch as the user,
// with the pull requests proposing more. Every change is a commit of the
// user, on a new branch opened as a pull request unless they ask otherwise.

const NEVER_USED = { reviews: 0, lastUsedAt: null };

export function Learnings() {
  const choice = useRepoChoice("/learnings");
  return (
    <>
      <PageHead
        title="Learnings"
        sub="What reviews know about a repository, from .ocra/learnings on its default branch. Each change you make here is a commit of yours, opened as a pull request."
        actions={choice.select}
      />
      {choice.body(Lightbulb, (repo, key) => (
        <RepoLearnings key={key} at={repo} />
      ))}
    </>
  );
}

function RepoLearnings(props: { at: RepoChoice }) {
  const query = new URLSearchParams(props.at).toString();
  const [after, setAfter] = useState<string | null>(null);
  const page = useLoad(
    () => api<LearningsView>(`/learnings?${query}${after ? `&after=${after}` : ""}`),
    [query, after],
  );
  const proposals = useLoad(
    () => api<LearningProposalsView>(`/learnings/proposals?${query}`),
    [query],
  );
  const [editing, setEditing] = useState<LearningView | "new" | null>(null);
  const [change, setChange] = useState<LearningChangeView | null>(null);
  const remove = useAction((l: LearningView) =>
    api<LearningChangeView>("/learnings/delete", {
      method: "POST",
      body: JSON.stringify({ ...props.at, id: l.id, expected: l.blobId }),
    }),
  );
  const done = (c: LearningChangeView | null) => {
    setEditing(null);
    if (!c) return;
    setChange(c);
    page.reload();
    proposals.reload();
  };
  const branch = page.data?.branch ?? "the default branch";
  const usage = page.data && { of: page.data.usage, days: page.data.usageDays };
  const form = (l?: LearningView) => (
    <LearningForm {...props.at} branch={branch} learning={l} done={done} />
  );

  return (
    <>
      {change && <ChangeOutcome change={change} branch={branch} />}
      {remove.error !== null && <ActionError what="delete the learning" error={remove.error} />}
      {proposals.data && <Proposals data={proposals.data} />}
      {editing !== null && form(editing === "new" ? undefined : editing)}
      {page.error && !page.data ? (
        <LoadError what="the learnings" error={page.error} retry={page.reload} />
      ) : !page.data ? (
        <Loading what="learnings" />
      ) : (
        <div className="card section">
          <div className="card-head">
            <h3>
              On {page.data.branch}{" "}
              <span className="muted">
                {page.data.total} · <span className="mono">{page.data.commit.slice(0, 7)}</span>
              </span>
            </h3>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing("new")}>
              <AddGlyph size={14} /> New learning
            </Button>
          </div>
          {page.data.learnings.length === 0 && page.data.invalid.length === 0 ? (
            <p className="subtle small card-pad m-0">
              No learnings yet. Add one here, or run{" "}
              <span className="mono">ocra learn --propose</span> to draft them from the repository's
              fix commits.
            </p>
          ) : (
            page.data.learnings.map((l) => (
              <LearningCard
                key={l.id}
                learning={l}
                usage={usage && { of: usage.of[l.id] ?? NEVER_USED, days: usage.days }}
                actions={
                  <span className="row-gap">
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditing(l)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="destructive-outline"
                      size="sm"
                      disabled={remove.busy}
                      onClick={async () => done((await remove.run(l)) ?? null)}
                    >
                      Delete
                    </Button>
                  </span>
                }
              />
            ))
          )}
          {page.data.invalid.map((f) => (
            <div className="learning invalid small" key={f.path}>
              <span className="mono">{f.path}</span>{" "}
              <span className="error-inline">is skipped by reviews: {f.reason}.</span>
            </div>
          ))}
          {(after || page.data.next) && (
            <div className="list-row">
              {after && (
                <Button type="button" variant="outline" size="sm" onClick={() => setAfter(null)}>
                  First page
                </Button>
              )}
              {page.data.next && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAfter(page.data?.next ?? null)}
                >
                  Next page
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
