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
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { navigate } from "./router.js";

/** `within` names its section for the search too: "insights" finds every Insights tab. */
export type CommandEntry = { label: string; to: string; within: string; external?: boolean };
export type CommandSection = { value: string; items: CommandEntry[] };

function isToggle(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

// coss's Command drops the primitive's item type, so its items come back unknown.
function searchText(item: unknown): string {
  const entry = item as CommandEntry;
  return `${entry.label} ${entry.within}`;
}

function go(entry: CommandEntry): void {
  if (entry.external) window.open(entry.to, "_blank", "noreferrer");
  else navigate(entry.to);
}

/** ⌘K (Ctrl+K): jump to any page the console shows its user. */
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
  const pick = (entry: CommandEntry) => {
    setOpen(false);
    go(entry);
  };
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup aria-label="Go to">
        <Command items={props.sections} itemToStringValue={searchText}>
          <CommandInput placeholder="Go to…" />
          <CommandPanel>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandList>
              {(section: CommandSection) => (
                <CommandGroup key={section.value} items={section.items}>
                  <CommandGroupLabel>{section.value}</CommandGroupLabel>
                  <CommandCollection>
                    {(entry: CommandEntry) => (
                      <CommandItem key={entry.to} value={entry} onClick={() => pick(entry)}>
                        {entry.label}
                      </CommandItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span>
              <KbdGroup>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
              </KbdGroup>{" "}
              to move
            </span>
            <span>
              <Kbd>↵</Kbd> to open
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
