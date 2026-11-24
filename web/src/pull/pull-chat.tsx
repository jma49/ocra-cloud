import Sparkles from "lucide-react/icons/sparkles";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  CodePlatformKind,
  PullChatMessageView,
  PullChatRequest,
  PullFindingView,
} from "../../../src/shared/index.js";
import { Drawer } from "../drawer.js";
import { Chat } from "../review-chat/chat.js";
import { KeyCaps } from "../shortcuts/keys.js";
import { ASK_KEY } from "./commands.js";

// "Ask ocra" on a pull request's page, in a drawer opened from its head: about
// the whole pull request, one of its open findings, or one of its files.

type Pull = { platform: CodePlatformKind; repo: string; number: number };

type About = { pull: Pull; findings: readonly PullFindingView[]; files: readonly string[] };

export function AskOcraButton(props: { onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label="Ask ocra"
            aria-haspopup="dialog"
            aria-keyshortcuts={ASK_KEY}
            onClick={(e) => {
              // Safari leaves a clicked button unfocused; the drawer gives focus back to what had it.
              e.currentTarget.focus();
              props.onOpen();
            }}
          />
        }
      >
        <Sparkles size={16} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>
        Ask ocra
        <KeyCaps keys={ASK_KEY} className="tip-key" />
      </TooltipPopup>
    </Tooltip>
  );
}

export function AskOcraDrawer(props: About & { onClose: () => void }) {
  return (
    <Drawer title="Ask ocra" onClose={props.onClose}>
      <PullChat pull={props.pull} findings={props.findings} files={props.files} />
    </Drawer>
  );
}

function PullChat(props: About) {
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
      bare
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
