// Rounded ORTHOGONAL SVG connector paths for the campaign canvas (§9B phase 5).
// A connector is built from VERTICAL (V) and HORIZONTAL (H) runs joined by
// quadratic (Q) corners — NEVER a diagonal L. Diagonal-free BY CONSTRUCTION:
// every command moves along exactly one axis (a Q corner's control + endpoint are
// chosen so the curve only rounds the right-angle turn). The corner radius is
// CLAMPED to half the shorter leg so a rounded corner never overshoots into a
// diagonal-looking artifact. Pure — no DOM, unit-tested first.

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The default corner radius (px) before clamping. */
export const CORNER_RADIUS = 14;

/**
 * orthogonalPath(from, to, radius?) — a rounded orthogonal path from `from` (a
 * source card's bottom-center) down to `to` (a target card's top-center).
 *   - same x: a single vertical segment `M x y1 V y2`.
 *   - offset x: down a bit → rounded corner → across → rounded corner → down,
 *     i.e. M → V (to the mid-y) → Q corner → H (across) → Q corner → V (to y2).
 * THROWS if `to.y <= from.y` (the builder only ever connects child-below-parent).
 */
export function orthogonalPath(from: Point, to: Point, radius: number = CORNER_RADIUS): string {
  if (!(to.y > from.y)) {
    throw new Error(`orthogonalPath: target must be below source (from.y=${from.y}, to.y=${to.y})`);
  }
  if (from.x === to.x) {
    return `M ${num(from.x)} ${num(from.y)} V ${num(to.y)}`;
  }
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dir = dx > 0 ? 1 : -1;
  // Clamp the radius to half the shorter leg so corners never overshoot.
  const vLeg = (to.y - from.y) / 2; // each vertical leg is ~half the drop
  const hLeg = Math.abs(dx);
  const r = Math.max(0, Math.min(radius, vLeg / 2, hLeg / 2));

  if (r === 0) {
    // Degenerate (legs too short for a rounded corner) — square orthogonal turns.
    return (
      `M ${num(from.x)} ${num(from.y)} ` +
      `V ${num(midY)} H ${num(to.x)} V ${num(to.y)}`
    );
  }

  // Down to just before the first corner, round into the horizontal run, across
  // to just before the second corner, round into the final vertical, down to to.
  return (
    `M ${num(from.x)} ${num(from.y)} ` +
    `V ${num(midY - r)} ` +
    `Q ${num(from.x)} ${num(midY)} ${num(from.x + dir * r)} ${num(midY)} ` +
    `H ${num(to.x - dir * r)} ` +
    `Q ${num(to.x)} ${num(midY)} ${num(to.x)} ${num(midY + r)} ` +
    `V ${num(to.y)}`
  );
}

/**
 * edgeMidpoint(from, to) — the anchor for the (+) edge-insertion control, placed
 * on the connector's first vertical run (always directly below the source, so it
 * sits on a clean down segment regardless of any horizontal jog).
 */
export function edgeMidpoint(from: Point, to: Point): Point {
  return { x: from.x, y: (from.y + to.y) / 2 };
}

/** Format a number for an SVG path (trim noisy float tails, keep it compact). */
function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}
