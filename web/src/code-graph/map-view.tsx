import Maximize from "lucide-react/icons/maximize";
import ZoomIn from "lucide-react/icons/zoom-in";
import ZoomOut from "lucide-react/icons/zoom-out";
import { type PointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "../icon-button.js";
import { EmptyNote } from "../ui.js";
import type { GraphClient } from "./client.js";
import type { Placed } from "./layout.js";
import { FileMark, uses } from "./marks.js";
import type { GraphPlace } from "./place.js";
import type { MapNode, MapView } from "./queries.js";
import { useAnswer } from "./use-graph.js";

// A folder's map: its children as discs as large as the symbols they
// define, joined by lines as heavy as the uses between them. Drag to move,
// ⌘ or Ctrl with the wheel (or a pinch) to zoom; the list beside it opens
// the same places by keyboard.

type Go = (to: GraphPlace) => void;
type View = { x: number; y: number; k: number };

const LABEL_CHARS = 22;
const PAD = 24;
/** On a crowded map, a part this small is named only when it, or a neighbour, is pointed at. */
const CROWDED = 24;
const NAMED_DEFS = 4;

export function FolderMap(props: { client: GraphClient; folder: string; go: Go }) {
  const asked = useAnswer(props.client, { type: "map", folder: props.folder });
  const [hover, setHover] = useState<string | null>(null);
  if (asked.error) return <EmptyNote>This folder's map could not be drawn.</EmptyNote>;
  if (!asked.data) return <p className="graph-wait">Drawing the map…</p>;
  const { view, placed } = asked.data;
  const open = (n: MapNode) =>
    props.go(
      n.kind === "folder" ? { view: "map", folder: n.path } : { view: "focus", path: n.path },
    );
  return (
    <div className="graph-work">
      <div className={`graph-stage map${asked.busy ? " is-busy" : ""}`}>
        {view.nodes.length === 0 ? (
          <EmptyNote>Nothing in this folder holds symbols the parser reads.</EmptyNote>
        ) : (
          <MapCanvas
            key={view.folder}
            view={view}
            placed={placed}
            hover={hover}
            setHover={setHover}
            open={open}
          />
        )}
      </div>
      <FolderList view={view} hover={hover} setHover={setHover} open={open} />
    </div>
  );
}

function MapCanvas(props: {
  view: MapView;
  placed: Placed[];
  hover: string | null;
  setHover: (p: string | null) => void;
  open: (n: MapNode) => void;
}) {
  const { view, placed, hover } = props;
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });
  const [at, setAt] = useState<View | null>(null);
  const drag = useRef<{ x: number; y: number; from: View; moved: boolean } | null>(null);
  const dragged = useRef(false);

  useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 520 });
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const fit = fitOf(placed, size);
  const v = at ?? fit;

  const pos = new Map(placed.map((p) => [p.path, p]));
  const nodes = new Map(view.nodes.map((n) => [n.path, n]));
  const max = Math.max(1, ...view.edges.map((e) => e.weight));
  const backbone = useMemo(() => backboneOf(view), [view]);
  const near = new Set<string>();
  if (hover) {
    for (const e of view.edges) {
      if (e.from === hover) near.add(e.to);
      if (e.to === hover) near.add(e.from);
    }
  }
  const zoom = (factor: number, cx = size.w / 2, cy = size.h / 2) => {
    const k = Math.min(4, Math.max(0.25, v.k * factor));
    setAt({ k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k });
  };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // React's wheel listener is passive, so it could not keep the page from zooming.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      zoomRef.current(Math.exp(-e.deltaY / 300), e.clientX - box.left, e.clientY - box.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragged.current = false;
    drag.current = { x: e.clientX, y: e.clientY, from: v, moved: false };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) svg.current?.setPointerCapture(e.pointerId);
    d.moved = true;
    dragged.current = true;
    setAt({ ...d.from, x: d.from.x + dx, y: d.from.y + dy });
  };
  const onUp = () => {
    drag.current = null;
  };
  const clicked = (n: MapNode) => {
    if (dragged.current) return;
    props.open(n);
  };

  return (
    <>
      <svg
        ref={svg}
        className={`map-canvas${drag.current?.moved ? " is-dragging" : ""}${hover ? " has-hover" : ""}`}
        role="img"
        aria-label={`Map of ${view.folder || "the repository"}: ${view.nodes.length} parts and the uses between them`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <g>
          {view.edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const lit = hover !== null && (e.from === hover || e.to === hover);
            if (!lit && !backbone.has(e)) return null;
            return (
              <line
                key={`${e.from}\n${e.to}`}
                className={`map-edge${lit ? " on" : ""}`}
                x1={a.x * v.k + v.x}
                y1={a.y * v.k + v.y}
                x2={b.x * v.k + v.x}
                y2={b.y * v.k + v.y}
                style={{ strokeWidth: 0.75 + 2.25 * Math.sqrt(e.weight / max) }}
              />
            );
          })}
          {placed.map((p) => {
            const n = nodes.get(p.path);
            if (!n) return null;
            const state =
              hover === null
                ? ""
                : hover === p.path
                  ? " is-lit"
                  : near.has(p.path)
                    ? " is-near"
                    : " is-dim";
            const r = p.r * v.k;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: the list beside the map opens the same places by keyboard
              <g
                key={p.path}
                className={`map-node ${n.kind}${state}`}
                transform={`translate(${p.x * v.k + v.x} ${p.y * v.k + v.y})`}
                onPointerEnter={() => props.setHover(p.path)}
                onPointerLeave={() => props.setHover(null)}
                onClick={() => clicked(n)}
              >
                <title>{`${n.path} · ${n.defs.toLocaleString()} symbols`}</title>
                <circle r={r} />
                {(placed.length <= CROWDED ||
                  n.defs >= NAMED_DEFS ||
                  (state !== " is-dim" && state !== "")) && (
                  <text y={r + 14} textAnchor="middle">
                    {shorten(n.label)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="map-tools">
        <IconButton label="Zoom in" icon={ZoomIn} onClick={() => zoom(1.4)} />
        <IconButton label="Zoom out" icon={ZoomOut} onClick={() => zoom(1 / 1.4)} />
        <IconButton label="Fit the map" icon={Maximize} onClick={() => setAt(null)} />
      </div>
    </>
  );
}

function FolderList(props: {
  view: MapView;
  hover: string | null;
  setHover: (p: string | null) => void;
  open: (n: MapNode) => void;
}) {
  const { view } = props;
  const rows = [...view.nodes].sort((a, b) => b.defs - a.defs || a.path.localeCompare(b.path));
  return (
    <aside className="card graph-details" aria-label="Details">
      <div className="card-head graph-details-head">
        <div className="grow">
          <h2>{view.folder ? <span className="mono">{view.folder}</span> : "Repository"}</h2>
          <div className="subtle small">
            {rows.length} part{rows.length === 1 ? "" : "s"}, the most symbols first
            {view.hidden > 0 ? ` · ${view.hidden} smaller not drawn` : ""}
          </div>
        </div>
      </div>
      <ul className="graph-rows">
        {rows.map((n) => (
          <li key={n.path}>
            <button
              type="button"
              className={`graph-row${props.hover === n.path ? " is-lit" : ""}`}
              onClick={() => props.open(n)}
              onPointerEnter={() => props.setHover(n.path)}
              onPointerLeave={() => props.setHover(null)}
              onFocus={() => props.setHover(n.path)}
              onBlur={() => props.setHover(null)}
            >
              <FileMark path={n.label} folder={n.kind === "folder"} />
              <span className="mono graph-row-name">{n.label}</span>
              <span className="graph-row-meta">
                {n.defs.toLocaleString()} symbol{n.defs === 1 ? "" : "s"}
                {n.usedFromOutside > 0 ? ` · ${uses(n.usedFromOutside)} from outside` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/**
 * The lines drawn at rest: each node's two heaviest, so the map shows its
 * main roads rather than every lane; pointing at a node draws all of its own.
 */
function backboneOf(view: MapView): Set<MapView["edges"][number]> {
  const kept = new Set<MapView["edges"][number]>();
  const taken = new Map<string, number>();
  for (const e of view.edges) {
    const a = taken.get(e.from) ?? 0;
    const b = taken.get(e.to) ?? 0;
    if (a >= 2 && b >= 2) continue;
    kept.add(e);
    taken.set(e.from, a + 1);
    taken.set(e.to, b + 1);
  }
  return kept;
}

const shorten = (label: string) =>
  label.length > LABEL_CHARS ? `…${label.slice(label.length - LABEL_CHARS + 1)}` : label;

/** The view that shows every node and its label, centred. */
function fitOf(placed: Placed[], size: { w: number; h: number }): View {
  if (placed.length === 0) return { x: size.w / 2, y: size.h / 2, k: 1 };
  const x0 = Math.min(...placed.map((p) => p.x - p.r));
  const x1 = Math.max(...placed.map((p) => p.x + p.r));
  // Labels keep their size at any zoom: room for the widest beside the discs.
  const label = 40;
  const y0 = Math.min(...placed.map((p) => p.y - p.r));
  const y1 = Math.max(...placed.map((p) => p.y + p.r));
  const k = Math.min(
    1.6,
    (size.w - PAD * 2 - label * 2) / Math.max(1, x1 - x0),
    (size.h - PAD * 2 - 20) / Math.max(1, y1 - y0),
  );
  return { k, x: size.w / 2 - ((x0 + x1) / 2) * k, y: size.h / 2 - ((y0 + y1) / 2) * k };
}
