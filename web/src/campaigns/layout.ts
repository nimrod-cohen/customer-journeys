// Auto-layout for the campaign canvas (§9B phase 5) — a Reingold-Tilford-style
// two-pass tree over the DSL edges. There are NO stored coordinates: positions
// are COMPUTED from the graph every render.
//   Pass 1 (BFS from startNode) assigns DEPTH → y row. Each child is strictly
//     BELOW its parent ⇒ down-only by construction; a re-convergence (diamond)
//     node takes max(parentDepth)+1, counted once.
//   Pass 2 packs x by SUBTREE WIDTH: a leaf = 1 unit, a parent centers over its
//     children, sibling subtrees are placed side-by-side so their x-extents are
//     disjoint; a condition's onTrue/onFalse arms thus fan to the sides.
// Because depth only ever increases along an edge, no connector is upward/back.
// Pure + deterministic — same def in → identical positions out.
//
// BRANCH LAYOUT (single-knee compact columns — the user's spec). A condition's
// two arms are STRAIGHT VERTICAL COLUMNS placed at center ± BRANCH_HALF_GAP — a
// COMPACT distance (the two ~200px cards sit close with a modest gap, NOT spread
// to the canvas edges). The arm's insert-(+) AND all of its stacked nodes share
// that ONE column x, so the connector has exactly ONE knee at the top (the split
// out from the If's center to the column) and ONE knee at the bottom (the column
// back in to the centered join) — nothing jogs in between. A NESTED branch inside
// an arm may widen that arm's extent (subtree-width packing still applies, just
// with a tighter base) so a SIMPLE arm stays compact.
import { outgoingEdges, type CampaignDefinition, type DslNode } from './model.js';

// Re-export so layout consumers (canvas + tests) get the single graph type here.
export type { CampaignDefinition } from './model.js';

/** A computed node position (grid units in col/row; px in x/y). */
export interface NodePosition {
  readonly depth: number;
  /** Column index (subtree-packed, may be fractional for a centered parent). */
  readonly col: number;
  /** Pixel x of the node-card center. */
  readonly x: number;
  /** Pixel y of the node-card top. */
  readonly y: number;
}

/** A connector between two positioned nodes (down-only, slot + label carried). */
export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
  readonly slot: 'next' | 'onTrue' | 'onFalse';
  readonly label?: string;
  /** Pixel anchor on the source card's bottom-center. */
  readonly fromPoint: { x: number; y: number };
  /** Pixel anchor on the target card's top-center. */
  readonly toPoint: { x: number; y: number };
  /**
   * The x of the dedicated VERTICAL lane this connector runs down. For a POPULATED
   * condition arm the lane IS the child's column (laneX === toPoint.x) — so the arm
   * is a SINGLE jog: down a short stub from the If's center, across to the column,
   * then straight DOWN the column to the child (one knee at the top). The arm's (+)
   * and the child share that column x — there is NO second jog between them. For an
   * EMPTY arm (the child is the directly-below CENTER join) the lane is a side lane
   * at from.x ± BRANCH_HALF_GAP so the two empty arms' (+)s sit on DISTINCT columns
   * yet still converge on the central join. A plain `next` edge uses laneX ===
   * toPoint.x (a straight V, or a single jog when the child is offset).
   */
  readonly laneX: number;
  /**
   * TRUE for a populated condition arm: the single knee is at the TOP (a short stub
   * down from the If's center, across to the child column, then the LONG vertical
   * straight DOWN that column to the child) — so the arm's (+) and the child share
   * the column. FALSE/absent for a plain `next` jog (knee at the bottom, the long
   * leg straight below the source) and for straight/empty-arm lane routes.
   */
  readonly kneeTop?: boolean;
}

/**
 * Layout geometry constants (px). Exported for the canvas to size its viewport.
 *
 * VERTICAL SPACING (min-segment floor): `rowHeight − cardHeight` is the DROP between
 * a card's bottom and the next card's top — the space every connector's vertical run
 * is carved from. It is kept comfortably above `MIN_SEGMENT` (orthogonal-path.ts) so
 * each edge's anchorable V run (the trunk V, a branch arm lane, the merged trunk)
 * clears the floor with room for its (+) and an inserted node. With rowHeight 184 /
 * cardHeight 72 the drop is 112px; the rail-inset routing keeps even the worst run
 * (the lane middle V = drop − 2·RAIL_INSET = 68px, the jog lower leg ≈ 76px) ≥ 64px.
 * EASY TO TWEAK: bump rowHeight (drop) and MIN_SEGMENT in tandem to taste.
 *
 * BRANCH/MERGE reservation: a condition's arm children + its diamond join sit one
 * full row (the 112px drop) below the If, so each arm gets its own TALL vertical lane
 * and the merged trunk after the join (join → continuation/Exit) is a full-row drop
 * too — both ≥ MIN_SEGMENT, so the per-arm (+)s and the merge (+) are never crammed.
 */
export const LAYOUT = {
  colWidth: 240,
  rowHeight: 184,
  cardWidth: 200,
  cardHeight: 72,
  padX: 80,
  padY: 40,
} as const;

/** The full computed layout: per-node positions + connector edges + bounds. */
export interface Layout {
  readonly positions: ReadonlyMap<string, NodePosition>;
  readonly edges: readonly LayoutEdge[];
  readonly width: number;
  readonly height: number;
}

/**
 * subtreeWidth(def, id, memo, visited) — the horizontal span (in columns) of the
 * subtree rooted at `id`. A leaf = 1. A parent = sum of its children's widths
 * (min 1). A re-convergence/diamond node is counted ONCE (the `visited` set), so
 * a shared descendant doesn't double-spread the layout.
 */
export function subtreeWidth(
  def: CampaignDefinition,
  id: string,
  memo: Map<string, number> = new Map(),
  visited: Set<string> = new Set(),
): number {
  if (memo.has(id)) return memo.get(id)!;
  if (visited.has(id)) return 0; // already counted via another path (diamond)
  visited.add(id);
  const node = def.nodes[id];
  if (!node) return 1;
  const children = outgoingEdges(id, node).map((e) => e.to);
  if (children.length === 0) {
    memo.set(id, 1);
    return 1;
  }
  let sum = 0;
  for (const c of children) sum += subtreeWidth(def, c, memo, visited);
  const w = Math.max(1, sum);
  memo.set(id, w);
  return w;
}

/**
 * layoutDefinition(def) — compute every node's {depth, col, x, y}. Two passes:
 *   1. depth = longest distance from start along edges (so a diamond join sits
 *      below BOTH parents: max(parentDepth)+1).
 *   2. x by subtree-width packing from the start, allotting each child a disjoint
 *      x-extent and centering a parent over its children.
 * Positions are derived ONLY from edges — any x/y present on the input is ignored.
 */
export function layoutDefinition(def: CampaignDefinition): Layout {
  const depth = computeDepths(def);

  // Pass 2: assign a column to each node by packing subtree widths. We walk from
  // the start, giving the subtree rooted at each node a [left, left+width) extent
  // and placing the node at the center of that extent. A node reached again
  // (diamond) keeps its FIRST assignment (counted once).
  const col = new Map<string, number>();
  const memo = new Map<string, number>();
  // Nodes reached by >1 edge (diamond joins) are NOT shifted by arm bands — they're
  // re-centered under their parents at the end (recenterJoins), so leaving them put
  // keeps each arm's shift exclusive to its own column.
  const joins = multiParentNodes(def);
  assignColumns(def, def.startNode, 0, col, memo, new Set(), joins);

  // Re-center a diamond join under the midpoint of its parents so the connectors
  // stay symmetric (its first-pass column may sit under only one arm).
  recenterJoins(def, col);

  const positions = new Map<string, NodePosition>();
  for (const id of Object.keys(def.nodes)) {
    const d = depth.get(id) ?? 0;
    const c = col.get(id) ?? 0;
    positions.set(id, {
      depth: d,
      col: c,
      x: LAYOUT.padX + c * LAYOUT.colWidth + LAYOUT.cardWidth / 2,
      y: LAYOUT.padY + d * LAYOUT.rowHeight,
    });
  }

  const edges = computeEdges(def, positions);

  let maxX = 0;
  let maxY = 0;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x + LAYOUT.cardWidth / 2);
    maxY = Math.max(maxY, p.y + LAYOUT.cardHeight);
  }
  return {
    positions,
    edges,
    width: maxX + LAYOUT.padX,
    height: maxY + LAYOUT.padY,
  };
}

/** Longest-path depth from start (so a join sits below both parents). */
function computeDepths(def: CampaignDefinition): Map<string, number> {
  const depth = new Map<string, number>();
  depth.set(def.startNode, 0);
  // Relax depths until stable (DAG ⇒ converges; bounded by node count).
  const ids = Object.keys(def.nodes);
  let changed = true;
  let guard = ids.length + 1;
  while (changed && guard-- > 0) {
    changed = false;
    for (const id of ids) {
      const d = depth.get(id);
      if (d === undefined) continue;
      const node = def.nodes[id];
      if (!node) continue;
      for (const e of outgoingEdges(id, node)) {
        const nd = d + 1;
        if ((depth.get(e.to) ?? -1) < nd) {
          depth.set(e.to, nd);
          changed = true;
        }
      }
    }
  }
  // Any node never reached (shouldn't happen for a valid def) → depth 0.
  for (const id of ids) if (!depth.has(id)) depth.set(id, 0);
  return depth;
}

/**
 * BRANCH_HALF_GAP — half the center-to-center distance (px) between a condition's
 * two arm columns. Picked COMPACT: 140px ⇒ the two columns sit 280px apart, so two
 * 200px cards have an 80px gap between them (close together, NOT spread to the
 * canvas edges). The branch column offset is this in COLUMN units (HALF_GAP_COLS),
 * and a nested branch inside an arm can only WIDEN past it (never narrower), so a
 * simple arm stays at exactly ±BRANCH_HALF_GAP.
 */
export const BRANCH_HALF_GAP = 140;

/** The branch half-gap expressed in column units (col → x is c·colWidth). */
const HALF_GAP_COLS = BRANCH_HALF_GAP / LAYOUT.colWidth;

/**
 * Recursive column packing; returns the next free left column. A CONDITION places
 * its two arms as COMPACT side columns at center ± HALF_GAP_COLS (the user's spec),
 * widening that offset only as much as a NESTED branch inside an arm demands (so a
 * simple arm stays compact). Every other node centers over its children as before.
 */
function assignColumns(
  def: CampaignDefinition,
  id: string,
  left: number,
  col: Map<string, number>,
  memo: Map<string, number>,
  placed: Set<string>,
  joins: Set<string>,
): number {
  if (placed.has(id)) return left; // diamond — already placed via another path
  placed.add(id);
  const node = def.nodes[id];
  const children = node ? outgoingEdges(id, node).map((e) => e.to).filter((c) => !placed.has(c)) : [];
  if (children.length === 0) {
    col.set(id, left);
    return left + 1;
  }

  // A CONDITION with exactly its two (un-placed) arms → compact symmetric columns.
  // We lay each arm's subtree out in its own band, then SHIFT the whole arm band so
  // its ROOT sits at center ± offset, where offset = max(HALF_GAP_COLS, half the
  // arm's own subtree width) — i.e. a nested branch widens the gap, a leaf keeps it
  // tight. The condition itself centers between the two arm roots.
  if (node?.type === 'condition' && children.length === 2) {
    const widths = children.map((c) => subtreeWidth(def, c, memo, new Set()));
    // Half-gap in cols, widened so neither arm's half-subtree overlaps the center.
    const offset = Math.max(HALF_GAP_COLS, widths[0]! / 2, widths[1]! / 2);
    const center = left + offset; // place center far enough right for the left arm
    const armRootTargets = [center - offset, center + offset];
    let cursor = center - offset; // left band starts here
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      const before = cursor;
      cursor = assignColumns(def, c, cursor, col, memo, placed, joins);
      const placedAt = col.get(c) ?? before;
      // Shift this arm's whole subtree so its ROOT lands on the target column (a
      // shared join is skipped — recenterJoins repositions it under both parents).
      const delta = armRootTargets[i]! - placedAt;
      if (delta !== 0) shiftSubtree(def, c, delta, col, new Set(), joins);
      cursor = Math.max(cursor, placedAt + delta + 1);
    }
    col.set(id, center);
    return cursor;
  }

  let cursor = left;
  const childCenters: number[] = [];
  for (const c of children) {
    const before = cursor;
    cursor = assignColumns(def, c, cursor, col, memo, placed, joins);
    // The child's own center column (it may itself have packed its subtree).
    childCenters.push(col.get(c) ?? before);
  }
  // Center the parent over the span of its placed children's centers.
  const lo = Math.min(...childCenters);
  const hi = Math.max(...childCenters);
  col.set(id, (lo + hi) / 2);
  return cursor;
}

/** Nodes reached by more than one edge (diamond joins). */
function multiParentNodes(def: CampaignDefinition): Set<string> {
  const indeg = new Map<string, number>();
  for (const id of Object.keys(def.nodes)) {
    const node = def.nodes[id];
    if (!node) continue;
    for (const e of outgoingEdges(id, node)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const joins = new Set<string>();
  for (const [id, n] of indeg) if (n > 1) joins.add(id);
  return joins;
}

/** Shift every node in the subtree rooted at `id` by `delta` columns, STOPPING at a
 *  shared join (a multi-parent node) — it belongs to no single arm and is recentered
 *  later. Diamond-safe via `seen`. */
function shiftSubtree(
  def: CampaignDefinition,
  id: string,
  delta: number,
  col: Map<string, number>,
  seen: Set<string>,
  joins: Set<string>,
): void {
  if (seen.has(id) || joins.has(id)) return;
  seen.add(id);
  if (col.has(id)) col.set(id, col.get(id)! + delta);
  const node = def.nodes[id];
  if (!node) return;
  for (const e of outgoingEdges(id, node)) shiftSubtree(def, e.to, delta, col, seen, joins);
}

/** Re-center each diamond join under the midpoint of its parents' columns. */
function recenterJoins(def: CampaignDefinition, col: Map<string, number>): void {
  // A join is a node with >1 incoming edge.
  const parents = new Map<string, string[]>();
  for (const id of Object.keys(def.nodes)) {
    const node = def.nodes[id];
    if (!node) continue;
    for (const e of outgoingEdges(id, node)) {
      const arr = parents.get(e.to) ?? [];
      arr.push(id);
      parents.set(e.to, arr);
    }
  }
  for (const [id, ps] of parents) {
    if (ps.length > 1) {
      const cols = ps.map((p) => col.get(p) ?? 0);
      col.set(id, (Math.min(...cols) + Math.max(...cols)) / 2);
    }
  }
}

/**
 * EMPTY_ARM_LANE — the side-lane offset (px) used ONLY by an EMPTY condition arm
 * (one whose target is the directly-below CENTER join). Such an arm's child is at
 * the same x as the If, so without a lane both empty arms' (+)s would stack on the
 * center column. We route each out to ±EMPTY_ARM_LANE so the two (+)s sit on
 * DISTINCT columns yet still converge on the central join. A POPULATED arm needs no
 * such lane — its child is already in its own ±BRANCH_HALF_GAP column.
 */
export const EMPTY_ARM_LANE = 28;

/**
 * computeEdges(def, positions) — one LayoutEdge per next/onTrue/onFalse, with the
 * source bottom-center + target top-center pixel anchors AND a vertical LANE x.
 * ASSERTS every edge is down-only (toPoint.y > fromPoint.y).
 *
 * LANE ASSIGNMENT (single-knee compact-column rework — the user's spec):
 *   • A POPULATED condition arm (child sits in its own ±BRANCH_HALF_GAP column, a
 *     DISTINCT x from the If) → laneX = toPoint.x. The connector is then a SINGLE
 *     jog: a short stub down from the If's center, ONE knee across to the column,
 *     then straight DOWN the column to the child. The arm's (+) anchors on that
 *     column vertical (verticalAnchor at from.x → actually at the child's x, since
 *     the upper leg of a jog with lane===to.x is at from.x; see verticalAnchor) —
 *     the (+) and the child share the column, NO second jog between them.
 *   • An EMPTY arm (child is the directly-below center join, toPoint.x === from.x)
 *     → laneX = from.x ± EMPTY_ARM_LANE so the two empty arms' (+)s sit on DISTINCT
 *     side columns yet still converge on the central join.
 *   • A plain `next` edge → laneX = toPoint.x (straight V or a single jog).
 * The fromPoint stays at the card-bottom CENTER, so the connector is axis-aligned
 * (V/H/V…) and down-only — ONE knee at the top, the merged trunk's join gives ONE
 * knee at the bottom.
 */
export function computeEdges(
  def: CampaignDefinition,
  positions: ReadonlyMap<string, NodePosition>,
): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  // A condition arm that points STRAIGHT at the branch's merge join (a multi-parent
  // node) is an EMPTY/passthrough arm — route it out to a side lane so its (+) sits
  // on its own side column (never over the OTHER arm's card) yet still converges on
  // the central join. A POPULATED arm (its target is its own column node) gets a
  // single top knee down its child column.
  const joins = multiParentNodes(def);
  for (const id of Object.keys(def.nodes)) {
    const node: DslNode | undefined = def.nodes[id];
    if (!node) continue;
    const from = positions.get(id);
    if (!from) continue;
    const out = outgoingEdges(id, node);
    for (const e of out) {
      const to = positions.get(e.to);
      if (!to) continue;
      const fromPoint = { x: from.x, y: from.y + LAYOUT.cardHeight };
      const toPoint = { x: to.x, y: to.y };
      if (!(toPoint.y > fromPoint.y)) {
        throw new Error(
          `computeEdges: edge ${id} -> ${e.to} is not downward (from.y=${fromPoint.y}, to.y=${toPoint.y})`,
        );
      }
      // Lane: a populated arm routes down its CHILD column (laneX = toPoint.x → a
      // single top jog, the (+) and child share the column). An EMPTY arm (child at
      // the same x as the If — the directly-below center join) routes out to a side
      // lane so the two empty (+)s don't stack. A plain `next` follows the target x.
      let laneX = toPoint.x;
      const isArm = e.slot === 'onTrue' || e.slot === 'onFalse';
      // EMPTY arm: it goes straight to the merge join (a shared multi-parent node),
      // OR (the fully-empty case) straight to a node directly below the If.
      const isEmptyArm = isArm && (joins.has(e.to) || toPoint.x === from.x);
      let kneeTop = false;
      if (isEmptyArm) {
        // Route out to a side lane so its (+) sits on its own column (off the other
        // arm's card) and the two empty (+)s never stack — still converges on the join.
        laneX = from.x + (e.slot === 'onTrue' ? -EMPTY_ARM_LANE : EMPTY_ARM_LANE);
      } else if (isArm) {
        // POPULATED arm — single knee at the TOP, long vertical down the child column.
        kneeTop = true;
      }
      const base = { from: id, to: e.to, slot: e.slot, fromPoint, toPoint, laneX, kneeTop } as const;
      edges.push(e.label !== undefined ? { ...base, label: e.label } : base);
    }
  }
  return edges;
}
