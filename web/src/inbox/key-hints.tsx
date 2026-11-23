import type { PageCommand } from "../page-commands.js";
import { KeyCaps } from "../shortcuts/keys.js";

// The list's keys, said once under it from the same commands the keys run,
// instead of in the page's opening line.

export function KeyHints(props: { commands: readonly PageCommand[] }) {
  const keyed = props.commands.filter((c) => c.key);
  return (
    <ul className="key-hints" aria-label="Keyboard shortcuts">
      {keyed.map((c) => (
        <li key={c.label}>
          <KeyCaps keys={c.key ?? ""} />
          <span>{c.label.toLowerCase()}</span>
        </li>
      ))}
    </ul>
  );
}
