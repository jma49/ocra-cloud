import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// A focus drawn as three columns: what uses it, it, and what it uses, each
// a list of rows, joined by curves as thick as the uses between them. The
// rows are buttons, so the diagram reads and works by keyboard too; under
// 760 px the columns stack and the curves go.

export type ColumnItem = {
  key: string;
  mark: ReactNode;
  name: ReactNode;
  sub?: ReactNode;
  meta?: string;
  /** How the row stands out: a changed signature, a new symbol, the focus. */
  tone?: "warn" | "ok" | "focus";
  /** Its name for a screen reader, when it opens something. */
  label?: string;
  open?: () => void;
};

export type Column = { title: string; items: ColumnItem[]; more?: ReactNode; empty: string };
export type Join = { from: string; to: string; weight: number };

/** Rows a column draws before it offers the rest. */
const SHOWN = 8;

/** A column's first rows, and a button that shows the rest. */
export function useCapped(items: ColumnItem[]): { items: ColumnItem[]; more?: ReactNode } {
  const [all, setAll] = useState(false);
  const rest = items.length - SHOWN;
  if (all || rest <= 0) return { items };
  return {
    items: items.slice(0, SHOWN),
    more: (
      <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
        Show {rest.toLocaleString()} more
      </Button>
    ),
  };
}

type Curve = { from: string; to: string; d: string; width: number };

export function ColumnGraph(props: {
  left: Column;
  center: Column;
  right?: Column;
  joins: Join[];
  label: string;
}) {
  const box = useRef<HTMLElement>(null);
  const [curves, setCurves] = useState<Curve[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  // Compared by value: a new array of the same joins draws nothing new.
  const joinsKey = JSON.stringify(props.joins);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const joins = JSON.parse(joinsKey) as Join[];
    const draw = () => setCurves(curvesOf(el, joins));
    draw();
    const watch = new ResizeObserver(draw);
    watch.observe(el);
    return () => watch.disconnect();
  }, [joinsKey]);

  const near = new Set<string>();
  if (hover) {
    for (const j of props.joins) {
      if (j.from === hover) near.add(j.to);
      if (j.to === hover) near.add(j.from);
    }
  }
  const column = (c: Column, side: "left" | "center" | "right") => (
    <section className={`gcol gcol-${side}`} aria-label={c.title}>
      <h3 className="gcol-title">{c.title}</h3>
      {c.items.length === 0 ? (
        <p className="gcol-empty">{c.empty}</p>
      ) : (
        <ul className="gcol-list">
          {c.items.map((item) => (
            <li key={item.key}>
              <Row
                item={item}
                lit={hover === item.key || near.has(item.key)}
                dim={hover !== null && hover !== item.key && !near.has(item.key)}
                hover={setHover}
              />
            </li>
          ))}
        </ul>
      )}
      {c.more && <div className="gcol-more">{c.more}</div>}
    </section>
  );

  return (
    <section className={`gcols${props.right ? "" : " two"}`} ref={box} aria-label={props.label}>
      <svg className="gcurves" aria-hidden="true">
        {curves.map((c) => (
          <path
            key={`${c.from}\n${c.to}`}
            d={c.d}
            style={{ strokeWidth: c.width }}
            className={hover && (c.from === hover || c.to === hover) ? "on" : hover ? "off" : ""}
          />
        ))}
      </svg>
      {column(props.left, "left")}
      {column(props.center, "center")}
      {props.right && column(props.right, "right")}
    </section>
  );
}

function Row(props: {
  item: ColumnItem;
  lit: boolean;
  dim: boolean;
  hover: (key: string | null) => void;
}) {
  const { item } = props;
  const className = [
    "gnode",
    item.tone ? `is-${item.tone}` : "",
    props.lit ? "is-lit" : "",
    props.dim ? "is-dim" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      <span className="gnode-mark">{item.mark}</span>
      <span className="gnode-text">
        <span className="gnode-name">{item.name}</span>
        {item.sub && <span className="gnode-sub">{item.sub}</span>}
      </span>
      {item.meta && <span className="gnode-meta">{item.meta}</span>}
    </>
  );
  const on = {
    onPointerEnter: () => props.hover(item.key),
    onPointerLeave: () => props.hover(null),
    onFocus: () => props.hover(item.key),
    onBlur: () => props.hover(null),
  };
  return item.open ? (
    <button
      type="button"
      className={className}
      data-node={item.key}
      aria-label={item.label}
      onClick={item.open}
      {...on}
    >
      {body}
    </button>
  ) : (
    <div className={className} data-node={item.key} {...on}>
      {body}
    </div>
  );
}

function curvesOf(box: HTMLElement, joins: readonly Join[]): Curve[] {
  const origin = box.getBoundingClientRect();
  const at = new Map<string, DOMRect>();
  for (const el of box.querySelectorAll<HTMLElement>("[data-node]")) {
    at.set(el.dataset.node ?? "", el.getBoundingClientRect());
  }
  const max = Math.max(1, ...joins.map((j) => j.weight));
  const out: Curve[] = [];
  for (const j of joins) {
    const a = at.get(j.from);
    const b = at.get(j.to);
    if (!a || !b || a.width === 0 || b.width === 0) continue;
    const x1 = a.right - origin.left;
    const y1 = a.top + a.height / 2 - origin.top;
    const x2 = b.left - origin.left;
    const y2 = b.top + b.height / 2 - origin.top;
    if (x2 <= x1) continue;
    const bend = (x2 - x1) / 2;
    out.push({
      from: j.from,
      to: j.to,
      d: `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`,
      width: 1 + 2 * Math.sqrt(j.weight / max),
    });
  }
  return out;
}
