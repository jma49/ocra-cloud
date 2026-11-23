import type { StackedPull } from "../../../src/shared/index.js";

type Layer = Pick<StackedPull, "number" | "parent">;

/**
 * The column each layer is drawn in, for a stack listed parents first: a
 * chain stays in its parent's column, and each further branch of a fork
 * starts one to the right.
 */
export function stackLanes(pulls: readonly Layer[]): Map<number, number> {
  const lanes = new Map<number, number>();
  const branches = new Map<number, number>();
  for (const p of pulls) {
    if (p.parent === null) {
      lanes.set(p.number, 0);
      continue;
    }
    const nth = branches.get(p.parent) ?? 0;
    branches.set(p.parent, nth + 1);
    lanes.set(p.number, (lanes.get(p.parent) ?? 0) + nth);
  }
  return lanes;
}

/** The layers next to `number`: the one it is stacked on, and the first stacked on it. */
export function stackBeside(
  pulls: readonly Layer[],
  number: number,
): { down: number | null; up: number | null } {
  const down = pulls.find((p) => p.number === number)?.parent ?? null;
  const up = pulls.find((p) => p.parent === number)?.number ?? null;
  return { down, up };
}
