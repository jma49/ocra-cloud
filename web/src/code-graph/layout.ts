import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { MapView } from "./queries.js";

// Where a folder's map draws each child: a force layout run to rest at once,
// never animated, so the same map always lands the same way.

export type Placed = { path: string; x: number; y: number; r: number };

const TICKS = 300;

/** A node's radius: its area grows with the symbols it defines. */
const radiusOf = (defs: number) => Math.min(30, 7 + Math.sqrt(defs) * 1.6);

export function layoutMap(view: MapView): Placed[] {
  type N = SimulationNodeDatum & { path: string; r: number };
  const nodes: N[] = view.nodes.map((n) => ({ path: n.path, r: radiusOf(n.defs) }));
  const max = Math.max(1, ...view.edges.map((e) => e.weight));
  type L = SimulationLinkDatum<N> & { strength: number };
  const links: L[] = view.edges.map((e) => ({
    source: e.from,
    target: e.to,
    strength: 0.05 + 0.35 * Math.sqrt(e.weight / max),
  }));
  forceSimulation(nodes)
    .force(
      "link",
      forceLink<N, L>(links)
        .id((n) => n.path)
        .distance((l) => {
          const a = l.source as N;
          const b = l.target as N;
          return a.r + b.r + 48;
        })
        .strength((l) => l.strength),
    )
    .force(
      "charge",
      forceManyBody<N>().strength((n) => -120 - n.r * 6),
    )
    .force(
      "collide",
      forceCollide<N>((n) => n.r + 18),
    )
    .force("x", forceX<N>(0).strength(0.06))
    .force("y", forceY<N>(0).strength(0.09))
    .stop()
    .tick(TICKS);
  return nodes.map((n) => ({ path: n.path, x: n.x ?? 0, y: n.y ?? 0, r: n.r }));
}
