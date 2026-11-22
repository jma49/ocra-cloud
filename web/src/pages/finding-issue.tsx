import CircleDot from "lucide-react/icons/circle-dot";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type FindingIssueAnswer,
  type FindingIssueDraftView,
  type FindingIssueView,
  MAX_ISSUE_BODY_CHARS,
  MAX_ISSUE_TITLE_CHARS,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { Drawer } from "../drawer.js";
import { num } from "../format.js";
import { useAction } from "../ui.js";

// "Open issue" on a finding: a draft from the finding, edited here and
// opened in the reviewed repository as the user; once opened, its link.

const https = (url: string) => url.startsWith("https://");

function IssueLink({ issue }: { issue: FindingIssueView }) {
  const label = (
    <>
      <CircleDot aria-hidden="true" />
      Issue #{issue.number}
    </>
  );
  return https(issue.url) ? (
    <a className="issue-link" href={issue.url} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  ) : (
    <span className="issue-link">{label}</span>
  );
}

const REFUSED: Record<"refused" | "pending", string> = {
  refused: "The platform refused to open the issue.",
  pending: "The issue is being opened; try again in a moment.",
};

export function FindingIssue(props: { findingId: string; issue: FindingIssueView | null }) {
  const [issue, setIssue] = useState(props.issue);
  const [draft, setDraft] = useState<FindingIssueDraftView | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const path = `/findings/${encodeURIComponent(props.findingId)}`;
  const load = useAction(async () => {
    const view = await api<FindingIssueDraftView>(`${path}/issue-draft`);
    if (view.issue) return setIssue(view.issue);
    setDraft(view);
    setTitle(view.title);
    setBody(view.body);
    setOpen(true);
  });
  const send = useAction(() =>
    api<FindingIssueAnswer>(`${path}/issue`, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setNote("");
    const r = await send.run();
    if (!r) return;
    if (r.outcome !== "done") return setNote(REFUSED[r.outcome]);
    setIssue(r.issue);
    setOpen(false);
  };
  if (issue) return <IssueLink issue={issue} />;
  const tooLong = body.length > MAX_ISSUE_BODY_CHARS;
  const fits = title.trim() !== "" && title.length <= MAX_ISSUE_TITLE_CHARS && !tooLong;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={load.busy}
        onClick={() => (draft ? setOpen(true) : load.run())}
      >
        Open issue
      </Button>
      {load.error !== null && (
        <span className="error small" role="alert">
          Could not draft the issue: {why(load.error)}.
        </span>
      )}
      {draft && open && (
        <Drawer
          title="New issue"
          heading={`New issue in ${draft.repo}`}
          onClose={() => setOpen(false)}
          onSubmit={submit}
          foot={
            <>
              <span className={`small grow ${tooLong ? "error-inline" : "subtle"}`}>
                {num(body.length)} of {num(MAX_ISSUE_BODY_CHARS)} characters
              </span>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={send.busy} disabled={!fits}>
                Open issue
              </Button>
            </>
          }
        >
          <p className="muted small m-0">
            Drafted from the finding. It is opened in the repository as you, once: this finding then
            links to it.
          </p>
          <label className="field">
            Title
            <input
              className="input"
              aria-label="Issue title"
              maxLength={MAX_ISSUE_TITLE_CHARS}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            Body
            <textarea
              className="input mono issue-text"
              aria-label="Issue body"
              spellCheck={false}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          {note && (
            <p className="note small m-0" role="status">
              {note}
            </p>
          )}
          {send.error !== null && (
            <p className="error" role="alert">
              Could not open the issue: {why(send.error)}.
            </p>
          )}
        </Drawer>
      )}
    </>
  );
}
