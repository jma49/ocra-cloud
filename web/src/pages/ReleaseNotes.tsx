import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type CodePlatformKind,
  MAX_RELEASE_BODY_CHARS,
  type ReleaseNotesView,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { useRead } from "../cache.js";
import { PublishDraft } from "../release-notes/publish.js";
import { ReleasePulls } from "../release-notes/pulls.js";
import { useToast } from "../toast.js";
import { LoadError, Loading, PageHead, useAction } from "../ui.js";

type Platforms = {
  platforms: {
    platform: CodePlatformKind;
    linked: boolean;
    repositories: { fullName: string }[];
  }[];
};
type Range = { repo: string; from: string; to: string; hidden: boolean; reviews: boolean };

const SEP = "|";

export function ReleaseNotes() {
  const repos = useRead<Platforms>("/platforms/repos");
  const [range, setRange] = useState<Range>({
    repo: "",
    from: "",
    to: "main",
    hidden: false,
    reviews: false,
  });
  const [notes, setNotes] = useState<ReleaseNotesView | null>(null);
  /** What the notes were drafted with, so the list matches them and not the form. */
  const [drafted, setDrafted] = useState<Range | null>(null);
  const [body, setBody] = useState("");
  const toast = useToast();
  const draft = useAction((r: Range) => {
    const [platform = "", repo = ""] = r.repo.split(SEP);
    const query = new URLSearchParams({
      platform,
      repo,
      from: r.from.trim(),
      to: r.to.trim(),
      hidden: String(r.hidden),
      reviews: String(r.reviews),
    });
    return api<ReleaseNotesView>(`/release-notes?${query}`);
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const made = await draft.run(range);
    if (!made) return;
    setNotes(made);
    setDrafted(range);
    setBody(made.body);
  };
  const set = (change: Partial<Range>) => setRange((r) => ({ ...r, ...change }));
  const choices = (repos.data?.platforms ?? [])
    .filter((p) => p.linked)
    .flatMap((p) => p.repositories.map((r) => `${p.platform}${SEP}${r.fullName}`));
  const ready = range.repo !== "" && range.from.trim() !== "" && range.to.trim() !== "";

  return (
    <>
      <PageHead
        title="Release notes"
        sub="Draft a release's notes from the pull requests merged between two tags, branches or commits, grouped by what their titles say. Nothing is kept here."
      />
      {repos.error && !repos.data ? (
        <LoadError what="your repositories" error={repos.error} retry={repos.reload} />
      ) : !repos.data ? (
        <Loading what="your repositories" />
      ) : choices.length === 0 ? (
        <p className="subtle small">
          Connect a code platform under Repositories first: the pull requests are read from it as
          you.
        </p>
      ) : (
        <form className="card card-pad stack" aria-label="Range" onSubmit={submit}>
          <div className="release-fields">
            <label className="grow">
              <span className="small">Repository</span>
              <select
                className="input"
                aria-label="Repository"
                value={range.repo}
                onChange={(e) => set({ repo: e.target.value })}
              >
                <option value="">Choose a repository</option>
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c.split(SEP)[1]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="small">From</span>
              <input
                className="input mono"
                aria-label="From"
                placeholder="v1.4.0"
                maxLength={200}
                value={range.from}
                onChange={(e) => set({ from: e.target.value })}
              />
            </label>
            <label>
              <span className="small">To</span>
              <input
                className="input mono"
                aria-label="To"
                maxLength={200}
                value={range.to}
                onChange={(e) => set({ to: e.target.value })}
              />
            </label>
            <Button type="submit" loading={draft.busy} disabled={draft.busy || !ready}>
              Draft notes
            </Button>
          </div>
          <div className="row-gap release-options">
            <label className="check">
              <input
                type="checkbox"
                checked={range.hidden}
                onChange={(e) => set({ hidden: e.target.checked })}
              />
              Maintenance changes
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={range.reviews}
                onChange={(e) => set({ reviews: e.target.checked })}
              />
              ocra's review of each
            </label>
          </div>
          {draft.error !== null && (
            <p className="error m-0" role="alert">
              {draft.error instanceof ApiError && draft.error.status === 404
                ? "No such repository, tag, branch or commit. Check both ends of the range."
                : `Could not draft the notes: ${why(draft.error)}.`}
            </p>
          )}
        </form>
      )}
      {notes && drafted && (
        <>
          <section className="section card" aria-label="Pull requests in the range">
            <div className="card-head">
              <div className="strong grow">
                {notes.pulls.length} pull {notes.pulls.length === 1 ? "request" : "requests"},{" "}
                <span className="mono">{notes.from}</span> to{" "}
                <span className="mono">{notes.to}</span>
              </div>
            </div>
            {notes.pulls.length === 0 ? (
              <p className="subtle small card-pad m-0">Nothing was merged in this range.</p>
            ) : (
              <div className="card-pad stack">
                {notes.truncated && (
                  <p className="note m-0">
                    The range holds more than one draft reads: these are its first{" "}
                    {notes.pulls.length}. Draft a shorter range for the rest.
                  </p>
                )}
                <ReleasePulls
                  pulls={notes.pulls}
                  marker={notes.platform === "gitlab" ? "!" : "#"}
                  showHidden={drafted.hidden}
                />
              </div>
            )}
          </section>
          <section className="section card card-pad stack" aria-label="Notes">
            <div className="row-gap">
              <div className="strong grow">Notes</div>
              {body !== notes.body && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setBody(notes.body)}
                >
                  Back to the draft
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(body);
                  toast("Markdown copied");
                }}
              >
                Copy Markdown
              </Button>
            </div>
            <textarea
              className="input mono release-body"
              aria-label="Release notes in Markdown"
              rows={16}
              maxLength={MAX_RELEASE_BODY_CHARS}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </section>
          {notes.drafts ? (
            <PublishDraft key={`${notes.repo} ${notes.to}`} notes={notes} body={body} />
          ) : (
            <p className="subtle small">
              This platform keeps no draft releases. Copy the Markdown into a release there.
            </p>
          )}
        </>
      )}
    </>
  );
}
