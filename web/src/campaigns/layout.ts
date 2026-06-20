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
   * The x of the dedicated VERTICAL lane this connector runs down (for a condition
   * arm). For a fanned arm it equals the child's x (toPoint.x); for an EMPTY arm
   * that goes straight to a directly-below join the two arms get DISTINCT lane x
   * (onTrue → left, onFalse → right) so their (+) anchors never stack. For a plain
   * `next` edge it equals toPoint.x (the route is a straight V or a single jog).
   */
  readonly laneX: number;
}

/** Layout geometry constants (px). Exported for the canvas to size its viewport. */
export const LAYOUT = {
  colWidth: 240,
  rowHeight: 140,
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
  assignColumns(def, def.startNode, 0, col, memo, new Set());

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

/** Recursive subtree-width column packing; returns the next free left column. */
function assignColumns(
  def: CampaignDefinition,
  id: string,
  left: number,
  col: Map<string, number>,
  memo: Map<string, number>,
  placed: Set<string>,
): number {
  if (placed.has(id)) return left; // diamond — already placed via another path
  placed.add(id);
  const node = def.nodes[id];
  const children = node ? outgoingEdges(id, node).map((e) => e.to).filter((c) => !placed.has(c)) : [];
  if (children.length === 0) {
    col.set(id, left);
    return left + 1;
  }
  let cursor = left;
  const childCenters: number[] = [];
  for (const c of children) {
    const before = cursor;
    cursor = assignColumns(def, c, cursor, col, memo, placed);
    // The child's own center column (it may itself have packed its subtree).
    childCenters.push(col.get(c) ?? before);
  }
  // Center the parent over the span of its placed children's centers.
  const lo = Math.min(...childCenters);
  const hi = Math.max(...childCenters);
  col.set(id, (lo + hi) / 2);
  return cursor;
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

/** Horizontal lane offset (px) for sibling arms that converge on the SAME join. */
export const ARM_LANE = 28;

/**
 * computeEdges(def, positions) — one LayoutEdge per next/onTrue/onFalse, with the
 * source bottom-center + target top-center pixel anchors AND a vertical LANE x.
 * ASSERTS every edge is down-only (toPoint.y > fromPoint.y).
 *
 * LANE ASSIGNMENT (the converging-diamond rework). A condition's arm runs DOWN a
 * dedicated vertical lane so its (+) anchors on a real vertical run:
 *   • FANNED arm (child fanned to a distinct column, toPoint.x ≠ source.x):
 *     laneX = toPoint.x — the connector's lower vertical leg IS the lane.
 *   • EMPTY arm straight to a directly-below join (toPoint.x === source.x): the two
 *     arms would otherwise share one column and stack. Give onTrue a LEFT lane and
 *     onFalse a RIGHT lane (source.x ∓ ARM_LANE) — a clean rectangle whose two arm
 *     (+)s sit on DISTINCT vertical lanes. The toPoint stays the shared join, so the
 *     arms still CONVERGE on one node.
 * A plain `next` edge uses laneX = toPoint.x (straight V or a single jog). The
 * fromPoint stays at the card-bottom CENTER for every edge (the split happens below
 * via the lanes), so the connector remains axis-aligned (V/H/V…) and down-only.
 */
export function computeEdges(
  def: CampaignDefinition,
  positions: ReadonlyMap<string, NodePosition>,
): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
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
      // Lane: a same-column arm (empty arm → directly-below join) gets a side lane
      // so the two arms separate; everything else routes down the target's column.
      let laneX = toPoint.x;
      if ((e.slot === 'onTrue' || e.slot === 'onFalse') && toPoint.x === from.x) {
        laneX = from.x + (e.slot === 'onTrue' ? -ARM_LANE : ARM_LANE);
      }
      edges.push(
        e.label !== undefined
          ? { from: id, to: e.to, slot: e.slot, label: e.label, fromPoint, toPoint, laneX }
          : { from: id, to: e.to, slot: e.slot, fromPoint, toPoint, laneX },
      );
    }
  }
  return edges;
}
