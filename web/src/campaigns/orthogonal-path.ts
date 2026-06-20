// Rounded ORTHOGONAL SVG connector paths for the campaign canvas (§9B phase 5).
// A connector is built from VERTICAL (V) and HORIZONTAL (H) runs joined by
// quadratic (Q) corners — NEVER a diagonal L. Diagonal-free BY CONSTRUCTION:
// every command moves along exactly one axis (a Q corner's control + endpoint are
// chosen so the curve only rounds the right-angle turn). The corner radius is
// CLAMPED to half the shorter leg so a rounded corner never overshoots into a
// diagonal-looking artifact. Pure — no DOM, unit-tested first.
//
// LANE ROUTING (the converging-diamond rework): a connector may carry an explicit
// `laneX` — the x of a dedicated VERTICAL lane the connector runs DOWN through
// before merging onto the target. This gives every arm of an If its OWN vertical
// segment (onTrue → left lane, onFalse → right lane) so:
//   • the (+) edge-insert control always anchors on a VERTICAL run (verticalAnchor),
//     never on a horizontal/corner;
//   • an EMPTY diamond (both arms straight to the join) routes as a clean rectangle
//     with the two lanes at DISTINCT x (the two arm (+)s never stack).
// When laneX coincides with from.x and to.x the route collapses to a single V.

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The default corner radius (px) before clamping. */
export const CORNER_RADIUS = 14;

/**
 * MIN_SEGMENT — the floor (px) every anchorable VERTICAL run is built to meet, so a
 * (+) control always has room and a node can be inserted on it. The layout
 * (layout.ts) sizes its rows so the drop between any two cards comfortably exceeds
 * this; the rail-inset routing below keeps the resulting V run ≥ MIN_SEGMENT.
 * EASY TO TWEAK: raise/lower this floor + LAYOUT.rowHeight in tandem.
 */
export const MIN_SEGMENT = 64;

/**
 * RAIL_INSET — the FIXED vertical distance (px) a horizontal crossing sits in from
 * the drop's ends. A lane route's two rails sit RAIL_INSET below `from` and above
 * `to`, so the middle lane V = drop − 2·RAIL_INSET; a jog's single crossing sits
 * RAIL_INSET below `from`, so its lower V leg = drop − RAIL_INSET − r. Choosing a
 * FIXED inset (not a fraction of the drop) keeps the anchorable run tall regardless
 * of the row height — pushing the corners to the ends instead of the middle.
 */
const RAIL_INSET = 22;

/**
 * orthogonalPath(from, to, laneX?, radius?) — a rounded orthogonal path from `from`
 * (a source card's bottom-center) down to `to` (a target card's top-center).
 *
 * Without `laneX` (or when the lane coincides with both x's): the classic route —
 *   - same x: a single vertical segment `M x y1 V y2`.
 *   - offset x: V (to mid-y) → Q corner → H (across) → Q corner → V (to y2).
 *
 * With a `laneX` that differs from from.x and/or to.x: a LANE route — down a stub,
 * across to the lane, DOWN the lane (the middle third), across to the target x,
 * down into the target. Any zero-length horizontal run (lane already at that x) is
 * dropped so a populated arm (child sits on the lane) collapses to V-H-V.
 *
 * THROWS if `to.y <= from.y` (the builder only ever connects child-below-parent).
 */
export function orthogonalPath(
  from: Point,
  to: Point,
  laneX?: number,
  radius: number = CORNER_RADIUS,
): string {
  if (!(to.y > from.y)) {
    throw new Error(`orthogonalPath: target must be below source (from.y=${from.y}, to.y=${to.y})`);
  }
  const lane = laneX ?? to.x;
  // No horizontal travel at all → a single straight vertical.
  if (from.x === lane && lane === to.x) {
    return `M ${num(from.x)} ${num(from.y)} V ${num(to.y)}`;
  }
  // Lane coincides with the target x (the common case: the child sits on the lane,
  // OR a same-x stub). Classic 3-run V-H-V around the mid-y.
  if (lane === to.x) {
    return jog(from, to, radius);
  }
  // Lane coincides with the source x and differs from target → a single jog whose
  // vertical leg IS the lane (down the source column, across, down to the target).
  if (lane === from.x) {
    return jog(from, to, radius);
  }
  // Full LANE route: stub down → across to lane → DOWN the lane → across → down.
  // The two rails sit a FIXED RAIL_INSET in from the drop's ends, so the middle
  // lane V run = drop − 2·RAIL_INSET stays tall (≥ MIN_SEGMENT for the laid-out
  // gap) rather than collapsing to a third of a small drop.
  const { yTop, yBot } = laneRailYs(from.y, to.y);
  const seg1 = jogTo(from.x, from.y, lane, yTop, radius); // into the lane top
  const seg2 = `V ${num(yBot)}`; // DOWN the lane (the anchorable vertical run)
  const seg3 = jogTail(lane, yBot, to.x, to.y, radius); // out of the lane into target
  return `M ${num(from.x)} ${num(from.y)} ${seg1} ${seg2} ${seg3}`.replace(/\s+/g, ' ').trim();
}

/**
 * The y of a JOG's single horizontal crossing. We place it a FIXED RAIL_INSET below
 * `from` (clamped so it never crosses below the drop's midpoint when the drop is
 * tiny), so the LOWER vertical leg — the anchorable run the (+) sits on — is long
 * (drop − RAIL_INSET − r) rather than half the drop. Pushing the corner to the top
 * keeps the lower V ≥ MIN_SEGMENT for the laid-out gap.
 */
function jogCrossingY(y1: number, y2: number): number {
  const drop = y2 - y1;
  return y1 + Math.min(RAIL_INSET, drop / 2);
}

/** The two lane rails (top/bottom), each a FIXED RAIL_INSET in from the drop's ends
 *  (clamped so they never cross for a tiny drop) — the middle lane V is between. */
function laneRailYs(y1: number, y2: number): { yTop: number; yBot: number } {
  const drop = y2 - y1;
  const inset = Math.min(RAIL_INSET, drop / 3);
  return { yTop: y1 + inset, yBot: y2 - inset };
}

/** A V-H-V jog from `from` to `to`, the horizontal crossing near the TOP (so the
 *  lower vertical leg is tall + anchorable). */
function jog(from: Point, to: Point, radius: number): string {
  const crossY = jogCrossingY(from.y, to.y);
  const dx = to.x - from.x;
  const dir = dx > 0 ? 1 : -1;
  const upLeg = crossY - from.y;
  const downLeg = to.y - crossY;
  const hLeg = Math.abs(dx);
  const r = Math.max(0, Math.min(radius, upLeg / 2, downLeg / 2, hLeg / 2));
  if (r === 0) {
    return `M ${num(from.x)} ${num(from.y)} V ${num(crossY)} H ${num(to.x)} V ${num(to.y)}`;
  }
  return (
    `M ${num(from.x)} ${num(from.y)} ` +
    `V ${num(crossY - r)} ` +
    `Q ${num(from.x)} ${num(crossY)} ${num(from.x + dir * r)} ${num(crossY)} ` +
    `H ${num(to.x - dir * r)} ` +
    `Q ${num(to.x)} ${num(crossY)} ${num(to.x)} ${num(crossY + r)} ` +
    `V ${num(to.y)}`
  );
}

/** A V-then-corner-into-H that LANDS on (x2,y2) without the leading M (rail entry). */
function jogTo(x1: number, y1: number, x2: number, y2: number, radius: number): string {
  if (x1 === x2) return `V ${num(y2)}`;
  const dir = x2 > x1 ? 1 : -1;
  const r = Math.max(0, Math.min(radius, Math.abs(y2 - y1) / 2, Math.abs(x2 - x1) / 2));
  if (r === 0) return `V ${num(y2)} H ${num(x2)}`;
  return (
    `V ${num(y2 - r)} ` +
    `Q ${num(x1)} ${num(y2)} ${num(x1 + dir * r)} ${num(y2)} ` +
    `H ${num(x2)}`
  );
}

/** An H-into-corner-then-V tail from the lane bottom (x1,y1) down to (x2,y2). */
function jogTail(x1: number, y1: number, x2: number, y2: number, radius: number): string {
  if (x1 === x2) return `V ${num(y2)}`;
  const dir = x2 > x1 ? 1 : -1;
  const r = Math.max(0, Math.min(radius, Math.abs(y2 - y1) / 2, Math.abs(x2 - x1) / 2));
  if (r === 0) return `H ${num(x2)} V ${num(y2)}`;
  return (
    `Q ${num(x1)} ${num(y1)} ${num(x1 + dir * r)} ${num(y1)} ` +
    `H ${num(x2 - dir * r)} ` +
    `Q ${num(x2)} ${num(y1)} ${num(x2)} ${num(y1 + r)} ` +
    `V ${num(y2)}`
  );
}

/**
 * verticalAnchor(from, to, laneX?) — the anchor for the (+) edge-insertion control,
 * GUARANTEED to sit on a VERTICAL run of the connector path (never a corner/H run):
 *   - straight edge (single V): the vertical midpoint.
 *   - jog (lane === to.x): the LOWER vertical leg at to.x (below the H run).
 *   - full lane route: the MIDDLE-third lane vertical at laneX.
 * Two arms leaving the SAME source therefore get DISTINCT anchors (distinct lane x),
 * so the buttons never stack (a stacked lower button is un-clickable).
 */
export function verticalAnchor(from: Point, to: Point, laneX?: number): Point {
  const lane = laneX ?? to.x;
  if (from.x === lane && lane === to.x) {
    return { x: from.x, y: (from.y + to.y) / 2 };
  }
  if (lane === to.x || lane === from.x) {
    // A jog: the final vertical leg runs at `to.x`, from the (top-placed) crossing
    // down to `to.y` — anchor at the MIDDLE of that tall lower V run.
    const crossY = jogCrossingY(from.y, to.y);
    const upLeg = crossY - from.y;
    const downLeg = to.y - crossY;
    const hLeg = Math.abs(to.x - from.x);
    const r = Math.max(0, Math.min(CORNER_RADIUS, upLeg / 2, downLeg / 2, hLeg / 2));
    // The lower vertical leg spans [crossY + r, to.y]; anchor at ITS midpoint so the
    // point is strictly inside the run. When lane===from.x (no jog horizontal) the
    // single vertical still spans this y, so the anchor is on it either way.
    const lowerTop = crossY + r;
    return { x: to.x, y: (lowerTop + to.y) / 2 };
  }
  // Full lane route: anchor on the MIDDLE of the (fixed-inset) lane vertical at laneX.
  const { yTop, yBot } = laneRailYs(from.y, to.y);
  return { x: lane, y: (yTop + yBot) / 2 };
}

/**
 * edgeMidpoint(from, to) — DEPRECATED midpoint (kept for callers/tests that don't
 * pass a lane). Prefer verticalAnchor, which always lands on a vertical run.
 */
export function edgeMidpoint(from: Point, to: Point): Point {
  return verticalAnchor(from, to);
}

/** Format a number for an SVG path (trim noisy float tails, keep it compact). */
function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}
