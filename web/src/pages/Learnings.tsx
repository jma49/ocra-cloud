import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CodePlatformKind,
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
import { ActionError, LoadError, Loading, PageHead, useAction, useLoad } from "../ui.js";

// A repository's learnings, read live from its default branch as the user,
// with the pull requests proposing more. Every change is a commit of the
// user, on a new branch opened as a pull request unless they ask otherwise.

type Listed = {
  platforms: {
    platform: CodePlatformKind;
    repositories: { id: string; fullName: string }[];
  }[];
};
type Repo = { platform: CodePlatformKind; repo: string };

const keyOf = (r: Repo) => `${r.platform}:${r.repo}`;

function initialRepo(): Repo | null {
  const q = new URLSearchParams(location.search);
  const platform = q.get("platform");
  const repo = q.get("repo");
  return (platform === "github" || platform === "gitlab") && repo ? { platform, repo } : null;
}

export function Learnings() {
  const listed = useLoad(() => api<Listed>("/platforms/repos"));
  const choices: Repo[] = (listed.data?.platforms ?? []).flatMap((p) =>
    p.repositories.map((r) => ({ platform: p.platform, repo: r.fullName })),
  );
  const [picked, setPicked] = useState<Repo | null>(initialRepo);
  const repo = picked ?? choices[0] ?? null;
  const pick = (r: Repo) => {
    setPicked(r);
    history.replaceState(null, "", `/learnings?${new URLSearchParams(r)}`);
  };
  return (
    <>
      <PageHead
        title="Learnings"
        sub="What reviews know about a repository, from .ocra/learnings on its default branch. Each change you make here is a commit of yours, opened as a pull request."
        actions={
          choices.length > 0 && (
            <select
              className="input"
              aria-label="Repository"
              value={repo ? keyOf(repo) : ""}
              onChange={(e) => {
                const r = choices.find((c) => keyOf(c) === e.target.value);
                if (r) pick(r);
              }}
            >
              {picked && !choices.some((c) => keyOf(c) === keyOf(picked)) && (
                <option value={keyOf(picked)}>{picked.repo}</option>
              )}
              {choices.map((c) => (
                <option key={keyOf(c)} value={keyOf(c)}>
                  {c.repo}
                </option>
              ))}
            </select>
          )
        }
      />
      {listed.error && !listed.data ? (
        <LoadError what="your repositories" error={listed.error} retry={listed.reload} />
      ) : !listed.data ? (
        <Loading what="your repositories" />
      ) : !repo ? (
        <div className="card empty-hero">
          <h3>No repository to read</h3>
          <p>Connect GitHub or GitLab under Repositories, and its repositories show up here.</p>
        </div>
      ) : (
        <RepoLearnings key={keyOf(repo)} at={repo} />
      )}
    </>
  );
}

function RepoLearnings(props: { at: Repo }) {
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
