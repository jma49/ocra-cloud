import { useState } from "react";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import type {
  AutoReviewRepoView,
  CommentCommand,
  CommentCommandOutcome,
  PullCommandsView,
  PullPauseView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useRead } from "../cache.js";
import { ago } from "../format.js";
import { useAction } from "../ui.js";

// What `@ocra` comments asked of this pull request, and its pause: set and
// lifted here as `@ocra pause` and `@ocra resume` do, without a comment.
// Shown only for a repository this account enrolled for reviews.

const COMMAND: Record<CommentCommand, string> = {
  review: "review",
  pause: "pause",
  resume: "resume",
  resolve: "resolve",
  fix: "fix",
  stop: "stop",
  generate_tests: "generate tests",
  generate_docstrings: "generate docstrings",
  help: "help",
};

const OUTCOME: Record<CommentCommandOutcome, { text: string; tone: string }> = {
  pending: { text: "Waiting", tone: "subtle" },
  done: { text: "Done", tone: "subtle" },
  refused: { text: "Refused", tone: "error-inline" },
  failed: { text: "Failed", tone: "error-inline" },
};

type Pull = { platform: string; repo: string; number: number };

export function OcraCommands(props: { pull: Pull }) {
  const repos = useRead<{ repos: AutoReviewRepoView[] }>("/auto-review/repos").data?.repos;
  const repo = repos?.find(
    (r) =>
      r.platform === props.pull.platform &&
      r.fullName.toLowerCase() === props.pull.repo.toLowerCase(),
  );
  if (!repo) return null;
  return <Commands repo={repo} number={props.pull.number} />;
}

function Commands(props: { repo: AutoReviewRepoView; number: number }) {
  const at = `/auto-review/repos/${encodeURIComponent(props.repo.id)}/pulls/${props.number}`;
  const { data } = useRead<PullCommandsView>(`${at}/commands`);
  const [set, setSet] = useState<boolean | null>(null);
  const change = useAction((pause: boolean) =>
    api<PullPauseView>(`${at}/pause`, { method: pause ? "PUT" : "DELETE" }),
  );
  if (!data) return null;
  const paused = set ?? data.paused;
  const flip = async () => {
    const done = await change.run(!paused);
    if (done) setSet(done.paused);
  };
  // A pause holds back only reviews that would start by themselves.
  const pausable = paused || props.repo.automatic;
  if (!pausable && data.commands.length === 0) return null;
  return (
    <div className="stack">
      {pausable && (
        <div className="row-gap checks-head">
          <span className="subtle small grow" role="status">
            {paused && <Status tone="warn">Paused</Status>}{" "}
            {paused
              ? "ocra does not review new commits here until it is resumed."
              : "ocra reviews new commits here as they arrive."}
          </span>
          <Button type="button" variant="outline" size="sm" loading={change.busy} onClick={flip}>
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      )}
      {change.error !== null && (
        <p className="error small m-0" role="alert">
          Could not {paused ? "resume" : "pause"} it: {why(change.error)}.
        </p>
      )}
      {data.commands.length > 0 && (
        <details>
          <summary className="config-refusal-head">
            Commands from comments ({data.commands.length})
          </summary>
          <ul className="pull-command-rows small">
            {data.commands.map((c) => (
              <li key={`${c.createdAt}:${c.command}`}>
                <span className="mono">@ocra {COMMAND[c.command]}</span>
                <span className={OUTCOME[c.outcome].tone}>{OUTCOME[c.outcome].text}</span>
                <span className="subtle">{ago(c.createdAt)}</span>
              </li>
            ))}
          </ul>
          {data.commands.some((c) => c.outcome === "refused") && (
            <div className="subtle small pull-command-note">
              A command is refused when its author may not push to the repository.
            </div>
          )}
        </details>
      )}
    </div>
  );
}
