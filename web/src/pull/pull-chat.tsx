import { useState } from "react";
import type {
  CodePlatformKind,
  PullChatMessageView,
  PullChatRequest,
  PullFindingView,
} from "../../../src/shared/index.js";
import { Chat } from "../review-chat/chat.js";

// "Ask ocra" on a pull request's page: about the whole pull request, one of
// its open findings, or one of its files.

type Pull = { platform: CodePlatformKind; repo: string; number: number };

export function PullChat(props: {
  pull: Pull;
  findings: readonly PullFindingView[];
  files: readonly string[];
}) {
  const { platform, repo, number } = props.pull;
  const query = new URLSearchParams({ platform, repo, number: String(number) });
  const [about, setAbout] = useState("");
  const [kind, value] = [about.slice(0, about.indexOf(":")), about.slice(about.indexOf(":") + 1)];
  const extra: Omit<PullChatRequest, "message" | "model"> = {
    ...props.pull,
    ...(kind === "finding" ? { finding: value } : {}),
    ...(kind === "file" ? { file: value } : {}),
  };
  const titles = new Map(props.findings.map((f) => [f.id, f.title]));
  const labelOf = (m: PullChatMessageView) =>
    m.finding ? `Finding ${titles.get(m.finding) ?? ""}`.trim() : m.file;
  return (
    <Chat<PullChatMessageView>
      read={`/pulls/chat?${query}`}
      ask="/pulls/chat"
      extra={extra}
      subject="this pull request"
      labelOf={labelOf}
      about={
        <select
          className="input"
          aria-label="What the question is about"
          value={about}
          onChange={(e) => setAbout(e.target.value)}
        >
          <option value="">The whole pull request</option>
          {props.findings.map((f) => (
            <option key={f.id} value={`finding:${f.id}`}>
              Finding: {f.title}
            </option>
          ))}
          {props.files.map((path) => (
            <option key={path} value={`file:${path}`}>
              File: {path}
            </option>
          ))}
        </select>
      }
    />
  );
}
