import type { LucideIcon } from "lucide-react";
import GitPullRequest from "lucide-react/icons/git-pull-request";
import { useEffect, useState } from "react";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "@/components/ui/command";
import { useOpenPageCommands } from "./page-commands.js";
import { recentPulls } from "./recent-pulls.js";
import { navigate } from "./router.js";
import { resultSections, unanswered } from "./search/sections.js";
import { useSearch } from "./search/use-search.js";
import { KeyCaps } from "./shortcuts/keys.js";

/** `within` names its section for the search too: "insights" finds every Insights tab. */
export type CommandEntry = {
  label: string;
  within: string;
  /** Said beside the label: a pull request's reference, a finding's file. */
  hint?: string;
  /** The key or keys that do the same outside the menu. */
  key?: string;
  icon?: LucideIcon;
} & (
  | { to: string; external?: boolean; run?: undefined }
  /** Something the open page or the console does. */
  | { run: () => void; to?: undefined }
);
export type CommandSection = { value: string; items: CommandEntry[] };

function isToggle(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

function pagesMatching(sections: CommandSection[], query: string): CommandSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = (e: CommandEntry) => {
    const text = `${e.label} ${e.within}`.toLowerCase();
    return words.every((w) => text.includes(w));
  };
  return sections
    .map((s) => ({ ...s, items: s.items.filter(found) }))
    .filter((s) => s.items.length > 0);
}

function go(entry: CommandEntry): void {
  if (entry.run) entry.run();
  else if (entry.external) window.open(entry.to, "_blank", "noreferrer");
  // A result's path is the server's: only one of this console's is followed.
  else if (entry.to.startsWith("/") && !entry.to.startsWith("//")) navigate(entry.to);
}

/** ⌘K (Ctrl+K): jump to a page of the console, or to what the server finds for the words typed. */
export function CommandMenu(props: { sections: CommandSection[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isToggle(e)) return;
      e.preventDefault();
      setOpen((was) => !was);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const page = useOpenPageCommands();
  const here: CommandSection[] = page.map((p) => ({
    value: p.title,
    items: p.commands.map((c) => ({ ...c, within: p.title })),
  }));
  const [query, setQuery] = useState("");
  const { results, searching } = useSearch(open ? query : "");
  const pick = (entry: CommandEntry) => {
    setOpen(false);
    go(entry);
  };
  const [reference, ...found] = results ? resultSections(results) : [];
  const jump = reference?.value === "Pull request" ? [reference] : [];
  const recent: CommandSection[] =
    open && query === ""
      ? [
          {
            value: "Recent",
            items: recentPulls()
              .filter((p) => decodeURIComponent(p.to) !== decodeURIComponent(location.pathname))
              .map((p) => ({
                label: p.title,
                hint: p.ref,
                to: p.to,
                within: "Recent",
                icon: GitPullRequest,
              })),
          },
        ].filter((s) => s.items.length > 0)
      : [];
  const shown = [
    ...recent,
    ...jump,
    ...pagesMatching([...here, ...props.sections], query),
    ...(reference && jump.length === 0 ? [reference] : []),
    ...found,
  ];
  const silent = results ? unanswered(results) : [];
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup aria-label="Go to">
        <Command items={shown} filteredItems={shown} value={query} onValueChange={setQuery}>
          <CommandInput placeholder="Search or go to…" />
          <CommandPanel>
            <CommandEmpty>{searching ? "Searching…" : "Nothing matches."}</CommandEmpty>
            {silent.length > 0 && (
              <p role="status" className="command-note">
                No answer from {silent.join(" and ")}, so no pull requests from there.
              </p>
            )}
            <CommandList>
              {(section: CommandSection) => (
                <CommandGroup key={section.value} items={section.items}>
                  <CommandGroupLabel>{section.value}</CommandGroupLabel>
                  <CommandCollection>
                    {(entry: CommandEntry) => (
                      <CommandItem
                        key={`${entry.to ?? ""} ${entry.label}`}
                        value={entry}
                        onClick={() => pick(entry)}
                      >
                        {entry.icon ? (
                          <entry.icon className="command-icon" size={16} aria-hidden="true" />
                        ) : null}
                        <span className="command-label">{entry.label}</span>
                        {entry.hint && <span className="command-hint">{entry.hint}</span>}
                        {entry.key && <KeyCaps keys={entry.key} className="command-key" />}
                      </CommandItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span>
              <KeyCaps keys="ArrowUp ArrowDown" /> to move
            </span>
            <span>
              <KeyCaps keys="Enter" /> to open
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
