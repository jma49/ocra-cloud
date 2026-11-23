import { Drawer } from "../drawer.js";
import { useOpenPageCommands } from "../page-commands.js";
import { GO_TO } from "./global-keys.js";
import { KeyCaps } from "./keys.js";

// Every key the console answers to right now: the open page's first, then
// those that hold everywhere.

type Shortcut = { keys: string; does: string };

const ANYWHERE: readonly Shortcut[] = [
  { keys: "Mod+K", does: "Search or go to" },
  { keys: "?", does: "Keyboard shortcuts" },
  { keys: "Escape", does: "Close a panel or menu" },
];

function Group(props: { title: string; shortcuts: readonly Shortcut[] }) {
  return (
    <section className="shortcuts-group" aria-label={props.title}>
      <h3 className="quiet-label">{props.title}</h3>
      <dl>
        {props.shortcuts.map((s) => (
          <div key={`${s.keys} ${s.does}`} className="shortcut">
            <dt>{s.does}</dt>
            <dd>
              <KeyCaps keys={s.keys} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutsDrawer(props: { onClose: () => void }) {
  const page = useOpenPageCommands();
  return (
    <Drawer title="Keyboard shortcuts" onClose={props.onClose}>
      {page.map((p) => {
        const keyed = p.commands.flatMap((c) => (c.key ? [{ keys: c.key, does: c.label }] : []));
        return keyed.length > 0 && <Group key={p.title} title={p.title} shortcuts={keyed} />;
      })}
      <Group title="Go to" shortcuts={GO_TO.map((g) => ({ keys: `g ${g.key}`, does: g.label }))} />
      <Group title="Anywhere" shortcuts={ANYWHERE} />
    </Drawer>
  );
}
