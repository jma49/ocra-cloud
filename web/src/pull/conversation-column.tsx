import PanelRightClose from "lucide-react/icons/panel-right-close";
import PanelRightOpen from "lucide-react/icons/panel-right-open";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type ConversationItem,
  type ConversationState,
  groupConversation,
} from "./conversation.js";
import { splitPath } from "./diff.js";
import { FileTypeIcon } from "./file-icon.js";

// The column beside a pull request's diff that lists its conversations by
// where they stand, each leading to its line. Whether it is open is kept in
// this browser; under 1100 px it sits below the diff.

const KEY = "ocra-pull-conversation";

/** Whether the column is open (the default) or folded to its button, as this browser last left it. */
export function useConversationOpen() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const pick = (to: boolean) => {
    setOpen(to);
    try {
      localStorage.setItem(KEY, to ? "open" : "closed");
    } catch {}
  };
  return { open, pick, toggle: () => pick(!open) };
}

const GROUPS: { state: ConversationState; label: string; open: boolean }[] = [
  { state: "open", label: "Open", open: true },
  { state: "outdated", label: "Outdated", open: true },
  { state: "resolved", label: "Resolved", open: false },
];

const where = (i: ConversationItem) =>
  i.line === null ? splitPath(i.path).name : `${splitPath(i.path).name}:${i.line}`;

function Item(props: { item: ConversationItem; onJump: (item: ConversationItem) => void }) {
  const { item } = props;
  return (
    <li>
      <button
        type="button"
        className="convo-item"
        title={item.line === null ? item.path : `${item.path}, line ${item.line}`}
        onClick={() => props.onJump(item)}
      >
        <span className="convo-where small">
          <FileTypeIcon name={splitPath(item.path).name} />
          <span className="mono subtle convo-path">{where(item)}</span>
          {item.comments > 1 && <span className="subtle num">{item.comments}</span>}
        </span>
        <span className="convo-title small">
          <span className="strong">{item.ocra ? "ocra" : (item.author ?? "Someone")}</span>{" "}
          {item.title}
        </span>
      </button>
    </li>
  );
}

export function ConversationColumn(props: {
  items: readonly ConversationItem[];
  open: boolean;
  onToggle: () => void;
  onJump: (item: ConversationItem) => void;
}) {
  const groups = groupConversation(props.items);
  const count = props.items.length;
  if (!props.open) {
    return (
      <aside className="pull-convo is-closed" aria-label="Conversation">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Show conversation (${count})`}
          title="Show conversation (T)"
          onClick={props.onToggle}
        >
          <PanelRightOpen aria-hidden="true" />
          <span className="num">{count}</span>
        </Button>
      </aside>
    );
  }
  return (
    <aside className="pull-convo" aria-label="Conversation">
      <div className="row-gap convo-head">
        <h2 className="card-title grow">Conversation</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Hide conversation"
          title="Hide conversation (T)"
          onClick={props.onToggle}
        >
          <PanelRightClose aria-hidden="true" />
        </Button>
      </div>
      {count === 0 && <p className="subtle small m-0">No comments on this diff yet.</p>}
      {GROUPS.map(
        (g) =>
          groups[g.state].length > 0 && (
            <details key={g.state} className="convo-group" open={g.open}>
              <summary className="pull-part-head small">
                <span className="fold" aria-hidden="true" />
                <span className="strong grow">{g.label}</span>
                <span className="subtle num">{groups[g.state].length}</span>
              </summary>
              <ul className="convo-list">
                {groups[g.state].map((i) => (
                  <Item key={i.id} item={i} onJump={props.onJump} />
                ))}
              </ul>
            </details>
          ),
      )}
    </aside>
  );
}
