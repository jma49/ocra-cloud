import { Kbd, KbdGroup } from "@/components/ui/kbd";

// How a key is written on screen. A space separates keys pressed one after
// the other ("g i"); "Mod" is ⌘ on a Mac and Ctrl elsewhere.

const mac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

const NAMES: Record<string, string> = { Enter: "↵", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓" };

const capOf = (key: string) => (key === "Mod" ? (mac() ? "⌘" : "Ctrl") : (NAMES[key] ?? key));

/** Key caps for a key or a sequence of keys. */
export function KeyCaps(props: { keys: string; className?: string }) {
  const presses = props.keys.split(" ");
  const caps = presses.flatMap((p) => p.split("+")).map(capOf);
  if (caps.length === 1) return <Kbd className={props.className}>{caps[0]}</Kbd>;
  return (
    <KbdGroup className={props.className}>
      {caps.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a sequence may repeat a key; its order is fixed.
        <Kbd key={i}>{c}</Kbd>
      ))}
    </KbdGroup>
  );
}
