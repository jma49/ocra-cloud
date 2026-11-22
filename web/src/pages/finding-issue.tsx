import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type FindingIssueAnswer,
  type FindingIssueDraftView,
  type FindingIssueView,
  MAX_ISSUE_BODY_CHARS,
  MAX_ISSUE_TITLE_CHARS,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useAction } from "../ui.js";

// "Open issue" on a finding: a draft from the finding, edited here and
// opened in the reviewed repository as the user; once opened, its link.

const https = (url: string) => url.startsWith("https://");

function IssueLink({ issue }: { issue: FindingIssueView }) {
  const label = `Issue #${issue.number}`;
  return https(issue.url) ? (
    <a className="small" href={issue.url} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  ) : (
    <span className="small">{label}</span>
  );
}

export function FindingIssue(props: { findingId: string; issue: FindingIssueView | null }) {
  const [issue, setIssue] = useState(props.issue);
  const [draft, setDraft] = useState<FindingIssueDraftView | null>(null);
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
  });
  const send = useAction(() =>
    api<FindingIssueAnswer>(`${path}/issue`, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    }),
  );
  const submit = async () => {
    const r = await send.run();
    if (!r) return;
    if (r.outcome === "done") {
      setIssue(r.issue);
      setDraft(null);
    } else {
      setNote(
        r.outcome === "pending"
          ? "The issue is being opened; try again in a moment."
          : "The platform refused to open the issue.",
      );
    }
  };
  if (issue) return <IssueLink issue={issue} />;
  if (!draft) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={load.busy}
          onClick={() => load.run()}
        >
          Open issue
        </Button>
        {load.error !== null && (
          <span className="error small" role="alert">
            Could not draft the issue: {why(load.error)}.
          </span>
        )}
      </>
    );
  }
  const fits =
    title.trim() !== "" &&
    title.length <= MAX_ISSUE_TITLE_CHARS &&
    body.length <= MAX_ISSUE_BODY_CHARS;
  return (
    <div className="stack">
      <span className="subtle small">New issue in {draft.repo}</span>
      <input
        className="input"
        aria-label="Issue title"
        maxLength={MAX_ISSUE_TITLE_CHARS}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="input"
        aria-label="Issue body"
        rows={10}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="event-actions">
        <Button size="sm" disabled={send.busy || !fits} onClick={submit}>
          Open issue
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
      {note && (
        <p className="note small m-0" role="status">
          {note}
        </p>
      )}
      {send.error !== null && (
        <p className="error small m-0" role="alert">
          Could not open the issue: {why(send.error)}.
        </p>
      )}
    </div>
  );
}
