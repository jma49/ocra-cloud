import { Kbd } from "@/components/ui/kbd";

// The inbox's keys (`keys.ts`), said once under the list instead of in the page's opening line.

const HINTS = [
  { keys: ["j", "k"], does: "move" },
  { keys: ["Enter"], does: "open" },
  { keys: ["o"], does: "open on the platform" },
  { keys: ["u"], does: "mark read or unread" },
  { keys: ["/"], does: "find" },
  { keys: ["r"], does: "refresh" },
] as const;

export function KeyHints() {
  return (
    <ul className="key-hints" aria-label="Keyboard shortcuts">
      {HINTS.map((h) => (
        <li key={h.does}>
          {h.keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
          <span>{h.does}</span>
        </li>
      ))}
    </ul>
  );
}
