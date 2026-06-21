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
 * PLUS_DIAMETER — the rendered diameter (px) of a `+` insertion control. The button is
 * `h-6 w-6` (24px) with a 1px `border` on each side (≈ 26px box) plus a focus ring /
 * shadow halo — taken as 28px, the full visual circle height. This is the unit RULE 1
 * pads against (PLUS_PAD === PLUS_DIAMETER): the line on each side of a `+` is at least
 * the circle's own height, so a `+` never visually touches a knee, node or another `+`.
 */
export const PLUS_DIAMETER = 28;

/**
 * PLUS_PAD — RULE 1 (v0.42.0; tightened v0.42.2): the MINIMUM length (px) of straight
 * VERTICAL line that must sit ABOVE a `+` insertion control AND below it. Every `+`
 * (campaign-edge-insert AND campaign-merge-insert) is centered on a vertical run with
 * ≥ PLUS_PAD of line on EACH side — so a `+` is never bare and never within PLUS_PAD of
 * a knee/corner. USER RULE (v0.42.2): the minimum pad on EACH side must be AT LEAST the
 * HEIGHT OF THE `+` CIRCLE, anywhere a `+` is rendered — so PLUS_PAD === PLUS_DIAMETER.
 * An anchorable run must fit line+`+`+line ⇒ MIN_SEGMENT ≥ 2·PLUS_PAD + PLUS_DIAMETER =
 * 3·PLUS_DIAMETER. EASY TO TWEAK in tandem with rowHeight.
 */
export const PLUS_PAD = PLUS_DIAMETER;

/**
 * PLUS_TOP_GAP — the COMFORTABLE length (px) of straight VERTICAL line a node-following
 * append-`+` (a `padHigh`-anchored control: a jog's / closing-edge's upper leg, straight
 * below its source node) is biased to leave ABOVE it — so its top spacer visually MATCHES
 * the centered trunk `+`s (a straight-V trunk over the laid-out drop has ~56px above; a
 * top-knee arm + has ~40px) instead of the bare minimum PLUS_PAD. The `+` is anchored at
 * `runTop + PLUS_TOP_GAP`, CLAMPED so there is still ≥ PLUS_PAD line BELOW it (on a short
 * run it falls back toward the run's center, keeping ≥ PLUS_PAD on BOTH sides — RULE 1).
 * For the gap to actually be realized (not clamped) a node-following run must be ≥
 * 2·PLUS_TOP_GAP; the layout sizes the closing-edge upper leg (JOIN_MERGE_DROP) to clear
 * that. Chosen 44px (between the trunk's 56 and the top-knee's 40) for visual consistency.
 */
export const PLUS_TOP_GAP = 44;

/**
 * MIN_SEGMENT — the floor (px) every anchorable VERTICAL run is built to meet, so a
 * (+) control always has line+`+`+line room (RULE 1) and a node can be inserted on it.
 * Sized = 2·PLUS_PAD + PLUS_DIAMETER so the run always fits PLUS_PAD above + the button
 * + PLUS_PAD below. With PLUS_PAD === PLUS_DIAMETER (v0.42.2) this is 3·PLUS_DIAMETER ≈
 * 84px. The layout (layout.ts) sizes its rows so the drop between any two cards
 * comfortably exceeds this; the rail-inset routing below keeps the resulting V run ≥
 * MIN_SEGMENT. EASY TO TWEAK: raise/lower this floor + LAYOUT.rowHeight in tandem.
 */
export const MIN_SEGMENT = 2 * PLUS_PAD + PLUS_DIAMETER; // 3·PLUS_DIAMETER = 84

/**
 * RAIL_INSET — the FIXED vertical distance (px) a horizontal crossing sits in from
 * the drop's ends. The routing is now SOURCE-SIDE-LONG: the vertical run that
 * descends straight from the source (at `from.x`, or the lane x just below it) is
 * the tall anchorable run, and the horizontal turn toward the target happens LOW.
 * So a jog's single crossing sits RAIL_INSET ABOVE `to` (near the bottom), making
 * the UPPER leg = drop − RAIL_INSET − r long; a lane route's two rails still sit
 * RAIL_INSET in from the drop's ends so the lane V = drop − 2·RAIL_INSET is tall.
 * Choosing a FIXED inset (not a fraction of the drop) keeps the anchorable run tall
 * regardless of row height — pushing the turn to the bottom, the (+) to the top.
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
  kneeTop = false,
  closeKnee = false,
  crossY?: number,
): string {
  if (!(to.y > from.y)) {
    throw new Error(`orthogonalPath: target must be below source (from.y=${from.y}, to.y=${to.y})`);
  }
  const lane = laneX ?? to.x;
  // No horizontal travel at all → a single straight vertical.
  if (from.x === lane && lane === to.x) {
    return `M ${num(from.x)} ${num(from.y)} V ${num(to.y)}`;
  }
  // POPULATED condition arm: a single knee at the TOP — short stub down from the
  // source center, across to the child column, then the LONG vertical DOWN the
  // column to the child. The (+) anchors on that column run (verticalAnchor).
  if (kneeTop && lane === to.x && to.x !== from.x) {
    return jogTopKnee(from, to, radius);
  }
  // A CLOSING jog into a merge join: the single crossing sits a FIXED inset BELOW the
  // source (near the TOP — like a top-knee), so the arm's append-(+) on the UPPER leg
  // at from.x sits RIGHT BELOW its source node regardless of how long the closing edge
  // is (a SHORT arm's edge spans the empty tail down to the merge depth — anchoring at
  // the mid would drift the (+) low, next to the merge (+); a top-biased crossing keeps
  // it HIGH). The LOWER leg at to.x = join.x is then the LONG central vertical the merge
  // (+) anchors on (closeKneeLowerRun), with a clear line above it and below it down to
  // the join card. (v0.41.9)
  if (closeKnee && lane === to.x && to.x !== from.x) {
    return jog(from, to, radius, closeKneeCrossY(from.y, to.y, crossY));
  }
  // Lane coincides with the target x (the common case: the child sits on the lane,
  // OR a same-x stub). Classic 3-run V-H-V around the mid-y (knee near the bottom).
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
 * The y of a JOG's single horizontal crossing. We place it a FIXED RAIL_INSET ABOVE
 * `to` (near the BOTTOM, clamped so it never rises above the drop's midpoint when the
 * drop is tiny), so the UPPER vertical leg — the run descending straight from the
 * source at `from.x`, which the (+) sits on — is long (drop − RAIL_INSET − r) rather
 * than half the drop. Pushing the corner to the BOTTOM keeps the UPPER source-side V
 * ≥ MIN_SEGMENT for the laid-out gap and puts the (+) straight below the source node,
 * before the turn toward the target.
 */
function jogCrossingY(y1: number, y2: number): number {
  const drop = y2 - y1;
  return y2 - Math.min(RAIL_INSET, drop / 2);
}

/** The two lane rails (top/bottom), each a FIXED RAIL_INSET in from the drop's ends
 *  (clamped so they never cross for a tiny drop) — the middle lane V is between. */
function laneRailYs(y1: number, y2: number): { yTop: number; yBot: number } {
  const drop = y2 - y1;
  const inset = Math.min(RAIL_INSET, drop / 3);
  return { yTop: y1 + inset, yBot: y2 - inset };
}

/**
 * topKneeCrossY — the y of a TOP-knee jog's single horizontal crossing: a FIXED
 * RAIL_INSET BELOW `from` (near the TOP, clamped so it never falls past the drop's
 * midpoint for a tiny drop). The LONG vertical leg then runs at `to.x` from this
 * crossing down to `to.y` — the child column — which is where the (+) anchors.
 */
function topKneeCrossY(y1: number, y2: number): number {
  const drop = y2 - y1;
  return y1 + Math.min(RAIL_INSET, drop / 2);
}

/** A V-H-V jog with the horizontal crossing near the TOP (a short stub down from the
 *  source center, across to the target column, then the LONG vertical DOWN that
 *  column to the target). Used for a populated condition arm — the (+) sits on the
 *  long lower leg at to.x, directly above the child (the arm's column). */
function jogTopKnee(from: Point, to: Point, radius: number): string {
  const crossY = topKneeCrossY(from.y, to.y);
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

/**
 * closeKneeCrossY — the y of a CLOSING jog's single horizontal crossing (RULE 2,
 * v0.42.0). When an explicit `crossYOverride` is supplied (the SHARED closure y the
 * layout computes from the join, just below the LONGER arm's last node), BOTH arms
 * knee back at THAT SAME y — so the two arms close together at the longer arm's end,
 * and the shorter arm's column extends straight DOWN to it (a plain vertical). The
 * override is clamped to keep both legs valid (between the source and the join).
 *
 * Without an override (the legacy/raw-geometry path) it falls back to a FIXED RAIL_INSET
 * BELOW `from` (near the TOP) — the per-arm crossing of the prior model.
 */
function closeKneeCrossY(y1: number, y2: number, crossYOverride?: number): number {
  if (crossYOverride !== undefined) {
    // Clamp strictly between the source and the join so both legs stay positive.
    return Math.max(y1 + 1, Math.min(crossYOverride, y2 - 1));
  }
  const drop = y2 - y1;
  return y1 + Math.min(RAIL_INSET, drop / 2);
}

/** A V-H-V jog from `from` to `to`. By default the horizontal crossing sits near the
 *  BOTTOM (so the UPPER vertical leg — descending straight from the source at from.x —
 *  is tall + anchorable; the (+) sits there, before the turn toward the target). A
 *  caller may pass an explicit `crossYOverride` (e.g. the MIDDLE for a closing jog into
 *  a merge join, so the LOWER leg at to.x is also tall for the merge (+)). */
function jog(from: Point, to: Point, radius: number, crossYOverride?: number): string {
  const crossY = crossYOverride ?? jogCrossingY(from.y, to.y);
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
 * closeKneeLowerRun(from, to) — the LOWER vertical leg of a CLOSING jog into a merge
 * join (a bottom-knee jog whose crossing is at the MIDDLE of the drop), i.e. the run
 * at `to.x` = join.x that descends from just below the (mid) closure corner down to
 * `to.y`. Returned as `{ y0, y1 }` (y0 = top of the run, just below the closure corner
 * = where the arms corner in; y1 = to.y = the join card top). This is the central
 * vertical the merge (+) anchors on: anchored in its MIDDLE there is a visible line
 * ABOVE it (closure corner → +) AND BELOW it (+ → join card). Pure; mirrors `jog` with
 * the mid crossing.
 */
export function closeKneeLowerRun(from: Point, to: Point, crossYOverride?: number): { y0: number; y1: number } {
  const crossY = closeKneeCrossY(from.y, to.y, crossYOverride);
  const downLeg = to.y - crossY;
  const upLeg = crossY - from.y;
  const hLeg = Math.abs(to.x - from.x);
  const r = Math.max(0, Math.min(CORNER_RADIUS, upLeg / 2, downLeg / 2, hLeg / 2));
  return { y0: crossY + r, y1: to.y };
}

/**
 * verticalAnchor(from, to, laneX?) — the anchor for the (+) edge-insertion control,
 * GUARANTEED to sit on the SOURCE-SIDE UPPER VERTICAL run of the connector path
 * (never a corner/H run), straight below the source node BEFORE any horizontal turn:
 *   - straight edge (single V): the vertical midpoint (already straight below source).
 *   - jog (lane === to.x | from.x): the UPPER vertical leg at `from.x`, above the
 *     (bottom-placed) H run — the (+) sits right under the source node.
 *   - full lane route: the UPPER portion of the lane vertical at laneX (the column
 *     straight below the source, per-arm), high in the run rather than centered.
 * Two arms leaving the SAME source therefore get DISTINCT anchors (distinct lane x),
 * so the buttons never stack — and an arm's (+) is HIGH (right under it), clearly
 * separated from the LOW merge (+) on the merged trunk; they never adjoin.
 */
export function verticalAnchor(
  from: Point,
  to: Point,
  laneX?: number,
  kneeTop = false,
  closeKnee = false,
  crossY?: number,
): Point {
  const lane = laneX ?? to.x;
  if (from.x === lane && lane === to.x) {
    // Straight V: center the + with PLUS_PAD above and below (the run is tall enough).
    return { x: from.x, y: padCenter(from.y, to.y) };
  }
  // CLOSING jog into a merge join: the arm (+) sits on the UPPER leg at `from.x`,
  // straight below the source — biased HIGH (right below the source node) but with
  // ≥ PLUS_PAD of line above AND below it (RULE 1). The LONG LOWER leg at to.x is
  // reserved for the merge (+) (closeKneeLowerRun). With a SHARED crossY (RULE 2) the
  // upper leg of the LONGER arm is short; padHigh keeps the + valid regardless.
  if (closeKnee && lane === to.x && to.x !== from.x) {
    const cross = closeKneeCrossY(from.y, to.y, crossY);
    const upLeg = cross - from.y;
    const downLeg = to.y - cross;
    const hLeg = Math.abs(to.x - from.x);
    const r = Math.max(0, Math.min(CORNER_RADIUS, upLeg / 2, downLeg / 2, hLeg / 2));
    const upperBot = cross - r; // the upper leg spans [from.y, cross - r]
    return { x: from.x, y: padHigh(from.y, upperBot) };
  }
  // POPULATED arm (top knee): the LONG vertical leg runs at `to.x` (the child column)
  // from the (top-placed) crossing down to `to.y`. Anchor on the child's column with
  // ≥ PLUS_PAD above and below (RULE 1) — directly above the child.
  if (kneeTop && lane === to.x && to.x !== from.x) {
    const cross = topKneeCrossY(from.y, to.y);
    const downLeg = to.y - cross;
    const upLeg = cross - from.y;
    const hLeg = Math.abs(to.x - from.x);
    const r = Math.max(0, Math.min(CORNER_RADIUS, upLeg / 2, downLeg / 2, hLeg / 2));
    const lowerTop = cross + r; // the long leg spans [cross + r, to.y]
    return { x: to.x, y: padCenter(lowerTop, to.y) };
  }
  if (lane === to.x || lane === from.x) {
    // A jog: the UPPER vertical leg runs at `from.x`, from `from.y` down to the
    // (bottom-placed) crossing — anchor HIGH (straight below the source) with ≥ PLUS_PAD
    // above and below (RULE 1), before the turn toward the target.
    const cross = jogCrossingY(from.y, to.y);
    const upLeg = cross - from.y;
    const downLeg = to.y - cross;
    const hLeg = Math.abs(to.x - from.x);
    const r = Math.max(0, Math.min(CORNER_RADIUS, upLeg / 2, downLeg / 2, hLeg / 2));
    const upperBot = cross - r; // the upper leg spans [from.y, cross - r]
    return { x: from.x, y: padHigh(from.y, upperBot) };
  }
  // Full lane route: anchor on the (fixed-inset) lane vertical at laneX, high in the
  // run but with ≥ PLUS_PAD above and below (RULE 1).
  const { yTop, yBot } = laneRailYs(from.y, to.y);
  return { x: lane, y: padHigh(yTop, yBot) };
}

/**
 * padCenter(y0, y1) — the y of a `+` centered on the vertical run [y0, y1], guaranteed
 * (when the run ≥ 2·PLUS_PAD) to leave ≥ PLUS_PAD of line ABOVE and BELOW it (RULE 1).
 * The geometric center already satisfies this for a run ≥ 2·PLUS_PAD; we keep it.
 */
function padCenter(y0: number, y1: number): number {
  return (y0 + y1) / 2;
}

/**
 * padHigh(y0, y1) — the y of a node-following append-`+` biased HIGH on the run [y0, y1]
 * with a COMFORTABLE PLUS_TOP_GAP of line ABOVE it (so its top spacer matches the centered
 * trunk `+`s), while still leaving ≥ PLUS_PAD of line BELOW (RULE 1). It sits at
 * `y0 + PLUS_TOP_GAP`, CLAMPED so:
 *   • it never falls below `y1 − PLUS_PAD` (≥ PLUS_PAD always remains BELOW), and
 *   • on a SHORT run (< PLUS_TOP_GAP + PLUS_PAD) it falls back toward the run's CENTER,
 *     keeping ≥ PLUS_PAD on BOTH sides (never crossing the midpoint).
 * So the append-+ gets a proper line above (≥ PLUS_TOP_GAP when the run is ≥ 2·PLUS_TOP_GAP,
 * which the layout guarantees for a node-following closing-edge upper leg) yet stays HIGH,
 * right under its node and well above the merge + on the (separate, lower) central run.
 */
function padHigh(y0: number, y1: number): number {
  const center = (y0 + y1) / 2;
  // The comfortable target: PLUS_TOP_GAP of line above. But never drop past the run's
  // center (so ≥ PLUS_PAD of line remains below on a run sized ≥ 2·PLUS_PAD). On a short
  // run the center wins → a balanced fallback with ≥ PLUS_PAD on both sides.
  return Math.min(y0 + PLUS_TOP_GAP, center);
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
