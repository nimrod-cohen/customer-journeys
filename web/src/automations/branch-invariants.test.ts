// Unit: the TWO first-class branch-rendering invariants (v0.42.0).
//
//  RULE 1 — EVERY `+` HAS A LINE ABOVE AND BELOW IT (≥ PLUS_PAD px each side).
//    Every `+` insertion control (automation-edge-insert AND automation-merge-insert) is
//    centered on a STRAIGHT VERTICAL run of its connector, with ≥ PLUS_PAD of line
//    ABOVE the anchor and ≥ PLUS_PAD BELOW it — never bare, never at a knee/corner.
//
//  RULE 2 — AN IF'S TWO ARMS ARE EQUAL HEIGHT; KNEE BACK ONLY AT THE LONGER ARM'S END.
//    Both arms of a condition span the SAME vertical height (= the longer arm's node
//    count). The shorter arm's column extends straight DOWN to the longer arm's last
//    node depth; BOTH arms knee back to the center at the SAME y (just below the
//    longer arm's last node) to converge at the merge join below that.
//
// These are pure layout invariants asserted over MANY graph shapes.
import { describe, it, expect } from 'vitest';
import {
  layoutDefinition,
  computeEdges,
  mergeAnchor,
  branchClosureY,
  PLUS_PAD,
  LAYOUT,
  BRANCH_HALF_GAP,
  type AutomationDefinition,
} from './layout.js';
import { orthogonalPath, verticalAnchor, MIN_SEGMENT, PLUS_TOP_GAP, PLUS_DIAMETER } from './orthogonal-path.js';

/** Collect the VERTICAL runs of an SVG path `d` as {x, y0, y1} (y0<y1), tracing the pen. */
function verticalRuns(d: string): Array<{ x: number; y0: number; y1: number }> {
  const tokens = d.trim().split(/\s+/);
  let i = 0;
  let cx = 0;
  let cy = 0;
  const n = (): number => Number(tokens[i++]);
  const runs: Array<{ x: number; y0: number; y1: number }> = [];
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      cx = n();
      cy = n();
    } else if (cmd === 'V') {
      const ny = n();
      runs.push({ x: cx, y0: Math.min(cy, ny), y1: Math.max(cy, ny) });
      cy = ny;
    } else if (cmd === 'H') {
      cx = n();
    } else if (cmd === 'Q') {
      n();
      n();
      cx = n();
      cy = n();
    }
  }
  return runs;
}

/** Count HORIZONTAL jogs (knees). */
function horizontalKnees(d: string): number {
  return d.trim().split(/\s+/).filter((t) => t === 'H').length;
}

/**
 * Assert EVERY direction change in path `d` is a NON-DEGENERATE rounded corner. Catches
 * the two ways a corner renders SQUARE while still "looking" curved to a naive check:
 *   (1) a bare axis flip (V immediately followed by H, or H by V, with no Q between);
 *   (2) a Q whose control point equals its start pen OR its endpoint (a straight Bézier).
 * The old `qCount ≥ N` check is blind to both. Pure string walk over the M/V/H/Q grammar.
 */
function assertAllCornersRounded(d: string, label: string): void {
  const t = d.trim().split(/\s+/);
  let i = 0;
  let px = 0;
  let py = 0;
  let prev = '';
  const n = (): number => Number(t[i++]);
  while (i < t.length) {
    const cmd = t[i++] ?? '';
    if (cmd === 'M') {
      px = n();
      py = n();
    } else if (cmd === 'V') {
      const ny = n();
      expect(prev !== 'H', `${label}: SQUARE corner (bare H→V) at (${px},${py}) in ${d}`).toBe(true);
      py = ny;
    } else if (cmd === 'H') {
      const nx = n();
      expect(prev !== 'V', `${label}: SQUARE corner (bare V→H) at (${px},${py}) in ${d}`).toBe(true);
      px = nx;
    } else if (cmd === 'Q') {
      const cx = n();
      const cy = n();
      const ex = n();
      const ey = n();
      const degenerate = (cx === px && cy === py) || (cx === ex && cy === ey);
      expect(!degenerate, `${label}: DEGENERATE Q ctrl(${cx},${cy}) pen(${px},${py}) end(${ex},${ey}) in ${d}`).toBe(
        true,
      );
      px = ex;
      py = ey;
    }
    prev = cmd;
  }
}

/**
 * RULE 1 oracle (tightened v0.42.2) — assert anchor `p` sits on ONE vertical run of `d`
 * that spans at least [p.y − PLUS_DIAMETER, p.y + PLUS_DIAMETER]: the USER RULE that the
 * minimum pad on EACH side of EVERY `+` is at least the height of the `+` CIRCLE. Since
 * PLUS_PAD === PLUS_DIAMETER (v0.42.2), this asserts ≥ PLUS_DIAMETER above AND below.
 * Returns nothing; throws via expect on failure.
 */
function assertLineAboveAndBelow(d: string, p: { x: number; y: number }, label: string): void {
  const runs = verticalRuns(d).filter((r) => Math.abs(r.x - p.x) < 1e-6);
  const hit = runs.find((r) => p.y >= r.y0 - 1e-6 && p.y <= r.y1 + 1e-6);
  expect(hit, `${label}: + anchor ${JSON.stringify(p)} not on a vertical run of ${d}`).toBeTruthy();
  expect(
    p.y - hit!.y0,
    `${label}: < +-circle-height line ABOVE the + (above=${(p.y - hit!.y0).toFixed(1)}, need ≥ ${PLUS_DIAMETER})`,
  ).toBeGreaterThanOrEqual(PLUS_DIAMETER - 1e-6);
  expect(
    hit!.y1 - p.y,
    `${label}: < +-circle-height line BELOW the + (below=${(hit!.y1 - p.y).toFixed(1)}, need ≥ ${PLUS_DIAMETER})`,
  ).toBeGreaterThanOrEqual(PLUS_DIAMETER - 1e-6);
}

/**
 * v0.42.1 oracle — a node-following APPEND/CLOSING-EDGE `+` (a `padHigh`-anchored control:
 * a jog's / arm-closing-edge's UPPER leg, straight below its source node) must have a
 * COMFORTABLE line ABOVE it (≥ PLUS_TOP_GAP, not merely PLUS_PAD), consistent with the
 * centered trunk +s — while still keeping ≥ PLUS_PAD line BELOW (RULE 1). The line-above
 * equals PLUS_TOP_GAP whenever the run is ≥ 2·PLUS_TOP_GAP (the layout sizes the closing
 * upper leg to clear that); on any shorter run padHigh falls back toward center, so we
 * assert ≥ PLUS_TOP_GAP only where the run can actually realize it.
 */
function assertComfortableTopGap(d: string, p: { x: number; y: number }, label: string): void {
  const runs = verticalRuns(d).filter((r) => Math.abs(r.x - p.x) < 1e-6);
  const hit = runs.find((r) => p.y >= r.y0 - 1e-6 && p.y <= r.y1 + 1e-6);
  expect(hit, `${label}: + anchor ${JSON.stringify(p)} not on a vertical run of ${d}`).toBeTruthy();
  const above = p.y - hit!.y0;
  const below = hit!.y1 - p.y;
  // Always ≥ PLUS_PAD below (RULE 1) — the comfortable top gap never starves the bottom.
  expect(below, `${label}: < PLUS_PAD line BELOW the append-+ (below=${below.toFixed(1)})`).toBeGreaterThanOrEqual(
    PLUS_PAD - 1e-6,
  );
  // The run is sized (by JOIN_MERGE_DROP / rowHeight) to realize the full PLUS_TOP_GAP.
  expect(above, `${label}: append-+ has only ${above.toFixed(1)}px above (< PLUS_TOP_GAP ${PLUS_TOP_GAP})`).toBeGreaterThanOrEqual(
    PLUS_TOP_GAP - 1e-6,
  );
}

// ---- Fixtures: a spread of graph shapes -----------------------------------

const linear: AutomationDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'segment_entry', next: 'wait1' },
    wait1: { type: 'wait', delay: { seconds: 172800 }, next: 'send1' },
    send1: { type: 'action', kind: 'send', template_id: 'tpl', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

// Equal arms: each arm has exactly ONE node, then merge → trunk.
const equalArms: AutomationDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'sendY', onFalse: 'sendN' },
    sendY: { type: 'action', kind: 'send', template_id: 'tplY', next: 'join' },
    sendN: { type: 'action', kind: 'send', template_id: 'tplN', next: 'join' },
    join: { type: 'action', kind: 'webhook', url: 'https://j', method: 'POST', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

// EMPTY If: BOTH arms empty — straight from the If to the merge/continuation (a tall
// empty diamond). Routes down side lanes that knee back to the center (rounded shoulders),
// a centered + on each lane, and a padded central run for the merge + (v0.42.3).
const emptyIf: AutomationDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'join', onFalse: 'join' },
    join: { type: 'action', kind: 'webhook', url: 'https://j', method: 'POST', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

// Yes=1, No=3: the SHORT arm (Yes) must extend straight down to the LONG arm's end.
const yes1no3: AutomationDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'sendY', onFalse: 'waitN' },
    sendY: { type: 'action', kind: 'send', template_id: 'tplY', next: 'join' },
    waitN: { type: 'wait', delay: { seconds: 3600 }, next: 'hookN' },
    hookN: { type: 'action', kind: 'webhook', url: 'https://n', method: 'POST', next: 'sendN' },
    sendN: { type: 'action', kind: 'send', template_id: 'tplN', next: 'join' },
    join: { type: 'action', kind: 'webhook', url: 'https://j', method: 'POST', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

// No=1, Yes=3: mirror of the above (the LONGER arm is the Yes side).
const no1yes3: AutomationDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'waitY', onFalse: 'sendN' },
    waitY: { type: 'wait', delay: { seconds: 3600 }, next: 'hookY' },
    hookY: { type: 'action', kind: 'webhook', url: 'https://y', method: 'POST', next: 'sendY' },
    sendY: { type: 'action', kind: 'send', template_id: 'tplY', next: 'join' },
    sendN: { type: 'action', kind: 'send', template_id: 'tplN', next: 'join' },
    join: { type: 'action', kind: 'webhook', url: 'https://j', method: 'POST', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

// A nested branch inside an arm: the Yes arm itself contains a condition.
const nestedInArm: AutomationDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'inner', onFalse: 'sendN' },
    inner: { type: 'condition', ast: { field: 'attributes.x', operator: '=', value: '1' }, onTrue: 'iy', onFalse: 'inJoin' },
    iy: { type: 'action', kind: 'send', template_id: 'ti', next: 'inJoin' },
    inJoin: { type: 'action', kind: 'webhook', url: 'https://ij', method: 'POST', next: 'join' },
    sendN: { type: 'action', kind: 'send', template_id: 'tplN', next: 'join' },
    join: { type: 'action', kind: 'webhook', url: 'https://j', method: 'POST', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

// merge-then-trunk: branch merges, then a single-out chain continues.
const mergeThenTrunk: AutomationDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'a', onFalse: 'b' },
    a: { type: 'action', kind: 'send', template_id: 'tplA', next: 'join' },
    b: { type: 'action', kind: 'send', template_id: 'tplB', next: 'join' },
    join: { type: 'action', kind: 'set_attribute', key: 'done', value: 'y', next: 'webhook' },
    webhook: { type: 'action', kind: 'webhook', url: 'https://x', method: 'POST', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

// deepArmChain: one arm is a LINEAR chain that only branches DEEP — contour packing must
// keep the linear top hugging the trunk (not reserve the deep branch's width all the way up).
const deepArmChain: AutomationDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'a', operator: '=', value: 'v' }, onTrue: 'chain1', onFalse: 'sendN' },
    chain1: { type: 'action', kind: 'send', template_id: 't1', next: 'chain2' },
    chain2: { type: 'action', kind: 'send', template_id: 't2', next: 'deepIf' },
    deepIf: { type: 'condition', ast: { field: 'x', operator: '=', value: '1' }, onTrue: 'da', onFalse: 'db' },
    da: { type: 'action', kind: 'send', template_id: 'tda', next: 'exitA' },
    db: { type: 'action', kind: 'send', template_id: 'tdb', next: 'exitB' },
    exitA: { type: 'exit' },
    exitB: { type: 'exit' },
    sendN: { type: 'action', kind: 'send', template_id: 'tN', next: 'exitN' },
    exitN: { type: 'exit' },
  },
};

const ALL_FIXTURES: Array<[string, AutomationDefinition]> = [
  ['linear', linear],
  ['equalArms', equalArms],
  ['emptyIf', emptyIf],
  ['yes1no3', yes1no3],
  ['no1yes3', no1yes3],
  ['nestedInArm', nestedInArm],
  ['mergeThenTrunk', mergeThenTrunk],
  ['deepArmChain', deepArmChain],
];

/** Every `+` anchor in a layout: edge-insert anchors + merge-insert anchors. */
function allPlusAnchors(def: AutomationDefinition): Array<{ label: string; d: string; p: { x: number; y: number } }> {
  const { positions, edges } = layoutDefinition(def);
  const out: Array<{ label: string; d: string; p: { x: number; y: number } }> = [];
  // automation-edge-insert: one per layout edge.
  for (const e of edges) {
    const d = orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop, e.closeKnee, e.crossY);
    const p = verticalAnchor(e.fromPoint, e.toPoint, e.laneX, e.kneeTop, e.closeKnee, e.crossY);
    out.push({ label: `edge-insert ${e.from}->${e.to} (${e.slot})`, d, p });
  }
  // automation-merge-insert: one per join that close-knee OR empty-arm edges converge on
  // (the central run the merge + sits on). Mirrors AutomationCanvas's merge-insert anchoring.
  const joinIds = new Set(
    edges.filter((e) => e.closeKnee === true || e.emptyArm === true).map((e) => e.to),
  );
  for (const joinId of joinIds) {
    const join = positions.get(joinId);
    const anchor = mergeAnchor(edges, positions, joinId);
    // The closing edge whose path carries the central run (a close-knee leaf, OR an
    // empty arm's side lane that knees back to center at the shared crossY).
    const closing = edges.find(
      (e) =>
        e.to === joinId &&
        (e.closeKnee === true || e.emptyArm === true) &&
        join !== undefined &&
        Math.abs(e.toPoint.x - join.x) < 1e-6,
    );
    if (!closing) continue;
    const d = orthogonalPath(closing.fromPoint, closing.toPoint, closing.laneX, undefined, closing.kneeTop, closing.closeKnee, closing.crossY);
    out.push({ label: `merge-insert @${joinId}`, d, p: { x: anchor.x, y: anchor.y } });
  }
  return out;
}

/**
 * The node-following APPEND/CLOSING-EDGE +s of a layout — the `padHigh`-anchored edge
 * inserts (a jog or an arm-closing-edge whose + sits on the UPPER leg straight below its
 * source node, at fromPoint.x). These are the +s v0.42.1 gives a comfortable PLUS_TOP_GAP
 * line above. A straight-V trunk + (centered, padCenter) and a top-knee arm + (padCenter on
 * the child column) are EXCLUDED — they already have a comfortable centered gap.
 */
function appendEdgePlusAnchors(def: AutomationDefinition): Array<{ label: string; d: string; p: { x: number; y: number } }> {
  const { edges } = layoutDefinition(def);
  const out: Array<{ label: string; d: string; p: { x: number; y: number } }> = [];
  for (const e of edges) {
    const straightV = Math.abs(e.fromPoint.x - e.laneX) < 1e-6 && Math.abs(e.laneX - e.toPoint.x) < 1e-6;
    if (straightV) continue; // centered trunk + (padCenter) — not an append/closing-edge +
    if (e.kneeTop) continue; // top-knee arm + is padCenter on the child column
    const d = orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop, e.closeKnee, e.crossY);
    const p = verticalAnchor(e.fromPoint, e.toPoint, e.laneX, e.kneeTop, e.closeKnee, e.crossY);
    // Only those that actually anchor on the source-side upper leg (padHigh at from.x).
    if (Math.abs(p.x - e.fromPoint.x) > 1e-6) continue;
    out.push({ label: `append-+ ${e.from}->${e.to} (${e.slot}${e.closeKnee ? ',close' : ''})`, d, p });
  }
  return out;
}

describe('RULE 1 — every + has ≥ PLUS_PAD line ABOVE and BELOW it', () => {
  it('PLUS_PAD and MIN_SEGMENT are sized so a line+`+`+line run always fits', () => {
    // v0.42.2 USER RULE: the per-side pad is AT LEAST the +-circle height everywhere.
    expect(PLUS_PAD).toBe(PLUS_DIAMETER);
    expect(MIN_SEGMENT).toBeGreaterThanOrEqual(2 * PLUS_PAD + PLUS_DIAMETER);
    expect(MIN_SEGMENT).toBe(3 * PLUS_DIAMETER); // = 84
  });

  for (const [name, def] of ALL_FIXTURES) {
    it(`${name}: EVERY + (edge-insert + merge-insert) has line above AND below`, () => {
      const anchors = allPlusAnchors(def);
      expect(anchors.length).toBeGreaterThan(0);
      for (const a of anchors) assertLineAboveAndBelow(a.d, a.p, `${name} ${a.label}`);
    });
  }

  it('no + sits within PLUS_PAD of a corner (the above/below check IS that property)', () => {
    // Re-stated as a direct property over the busiest fixture.
    for (const a of allPlusAnchors(yes1no3)) assertLineAboveAndBelow(a.d, a.p, `yes1no3 ${a.label}`);
  });
});

describe('v0.42.1 — append/closing-edge +s have a COMFORTABLE line above (≥ PLUS_TOP_GAP)', () => {
  it('PLUS_TOP_GAP is comfortably above PLUS_PAD (a proper spacer, not the minimum)', () => {
    expect(PLUS_TOP_GAP).toBeGreaterThan(PLUS_PAD);
  });

  for (const [name, def] of [
    ['equalArms', equalArms],
    ['yes1no3', yes1no3],
    ['no1yes3', no1yes3],
    ['linear', linear],
  ] as const) {
    it(`${name}: every append/closing-edge + has ≥ PLUS_TOP_GAP line above AND ≥ PLUS_PAD below`, () => {
      const anchors = appendEdgePlusAnchors(def);
      // equalArms/yes1no3/no1yes3 all have arm-closing edges → at least one append-+.
      // (linear has the same single-jog/straight kind; if it produces none that's fine.)
      if (name !== 'linear') expect(anchors.length).toBeGreaterThan(0);
      for (const a of anchors) assertComfortableTopGap(a.d, a.p, `${name} ${a.label}`);
    });
  }

  it('the arm-closing + stays HIGH (near its node) and well ABOVE the merge + below it', () => {
    const { positions, edges } = layoutDefinition(yes1no3);
    const join = positions.get('join')!;
    const merge = mergeAnchor(edges, positions, 'join');
    for (const e of edges.filter((x) => x.closeKnee === true)) {
      const p = verticalAnchor(e.fromPoint, e.toPoint, e.laneX, e.kneeTop, e.closeKnee, e.crossY);
      // The append-+ sits comfortably above the merge + (they never adjoin).
      expect(merge.y - p.y).toBeGreaterThan(PLUS_PAD);
      // And it stays near its own source node (within one row's drop), not drifted down.
      expect(p.y - e.fromPoint.y).toBeLessThan(LAYOUT.rowHeight);
    }
    expect(join.y).toBeGreaterThan(merge.y);
  });
});

describe('RULE 2 — equal arm heights; knee back only at the longer arm’s end', () => {
  /** The arm-leaf → join closing edges for a given join. */
  function closingsInto(def: AutomationDefinition, joinId: string): ReturnType<typeof computeEdges> {
    const { positions } = layoutDefinition(def);
    const edges = computeEdges(def, positions);
    return edges.filter((e) => e.to === joinId && e.closeKnee === true);
  }

  it('equal arms: both close at the same y, just below the (shared-depth) last node', () => {
    const { positions } = layoutDefinition(equalArms);
    const closings = closingsInto(equalArms, 'join');
    expect(closings.length).toBe(2);
    const ys = closings.map((c) => branchClosureY(c));
    expect(ys[0]).toBeCloseTo(ys[1]!, 5);
    // Closure is below both arm leaves' bottoms.
    for (const c of closings) expect(branchClosureY(c)).toBeGreaterThan(c.fromPoint.y);
    // And above the join card.
    const join = positions.get('join')!;
    for (const c of closings) expect(branchClosureY(c)).toBeLessThan(join.y);
  });

  for (const [name, def, shortLeaf, longLeaf] of [
    ['yes1no3', yes1no3, 'sendY', 'sendN'],
    ['no1yes3', no1yes3, 'sendN', 'sendY'],
  ] as const) {
    it(`${name}: BOTH arms' closing knees are at the SAME y, just after the LONGER arm's last node`, () => {
      const { positions } = layoutDefinition(def);
      const closings = closingsInto(def, 'join');
      expect(closings.length).toBe(2);
      const short = closings.find((c) => c.from === shortLeaf)!;
      const long = closings.find((c) => c.from === longLeaf)!;
      // RULE 2: equal closure y for both arms.
      expect(branchClosureY(short)).toBeCloseTo(branchClosureY(long), 5);
      // The closure sits just AFTER the LONGER arm's last node (below its card bottom,
      // within a modest gap — NOT up near the SHORT arm's node).
      const longLeafPos = positions.get(longLeaf)!;
      const longCardBottom = longLeafPos.y + 72; // cardHeight
      expect(branchClosureY(long)).toBeGreaterThan(longCardBottom - 1e-6);
      // The short arm's leaf is HIGHER than the closure (it extends straight down).
      const shortLeafPos = positions.get(shortLeaf)!;
      expect(shortLeafPos.y).toBeLessThan(branchClosureY(short));
      // The merge join is BELOW both closures.
      const join = positions.get('join')!;
      expect(join.y).toBeGreaterThan(branchClosureY(short));
      expect(join.y).toBeGreaterThan(branchClosureY(long));
    });

    it(`${name}: the SHORT arm tail is a single PLAIN vertical (one knee at the bottom, one append-+ under its node)`, () => {
      const { positions } = layoutDefinition(def);
      const edges = computeEdges(def, positions);
      const fromShort = edges.filter((e) => e.from === shortLeaf);
      expect(fromShort.length).toBe(1);
      const d = orthogonalPath(fromShort[0]!.fromPoint, fromShort[0]!.toPoint, fromShort[0]!.laneX, undefined, fromShort[0]!.kneeTop, fromShort[0]!.closeKnee, fromShort[0]!.crossY);
      expect(horizontalKnees(d)).toBe(1); // exactly one (bottom) knee
      // Its append-+ sits right under its node (within one trunk gap), with line above+below.
      const p = verticalAnchor(fromShort[0]!.fromPoint, fromShort[0]!.toPoint, fromShort[0]!.laneX, fromShort[0]!.kneeTop, fromShort[0]!.closeKnee, fromShort[0]!.crossY);
      const leaf = positions.get(shortLeaf)!;
      expect(p.x).toBeCloseTo(leaf.x, 5);
      expect(p.y).toBeGreaterThan(leaf.y + 72 - 1e-6); // below the card
      assertLineAboveAndBelow(d, p, `${name} short-arm append-+`);
    });
  }

  it('the merge + is on the central run below both closures, with line above and below', () => {
    const { positions } = layoutDefinition(yes1no3);
    const edges = computeEdges(yes1no3, positions);
    const anchor = mergeAnchor(edges, positions, 'join');
    const join = positions.get('join')!;
    expect(anchor.x).toBeCloseTo(join.x, 5);
    const closing = edges.find((e) => e.to === 'join' && e.closeKnee === true && Math.abs(e.toPoint.x - join.x) < 1e-6)!;
    const d = orthogonalPath(closing.fromPoint, closing.toPoint, closing.laneX, undefined, closing.kneeTop, closing.closeKnee, closing.crossY);
    assertLineAboveAndBelow(d, { x: anchor.x, y: anchor.y }, 'yes1no3 merge +');
  });
});

describe('EMPTY If (both arms empty → straight to the merge) — v0.42.3', () => {
  /** The two empty-arm lane edges of emptyIf, plus their layout. */
  function emptyArmEdges(): { positions: ReturnType<typeof layoutDefinition>['positions']; edges: ReturnType<typeof computeEdges>; arms: ReturnType<typeof computeEdges> } {
    const { positions } = layoutDefinition(emptyIf);
    const edges = computeEdges(emptyIf, positions);
    const arms = edges.filter((e) => e.emptyArm === true);
    return { positions, edges, arms };
  }

  it('both arms are flagged empty, on DISTINCT side lanes, with a SHARED crossY', () => {
    const { arms } = emptyArmEdges();
    expect(arms.length).toBe(2);
    // Distinct lanes (no stacking of the two +s).
    expect(arms[0]!.laneX).not.toBe(arms[1]!.laneX);
    // RULE 2 — both close at the SAME y.
    expect(arms[0]!.crossY).toBeDefined();
    expect(arms[0]!.crossY).toBeCloseTo(arms[1]!.crossY!, 5);
  });

  it('each empty arm + is CENTERED on its lane run (≥ PLUS_PAD above AND below)', () => {
    const { arms } = emptyArmEdges();
    for (const e of arms) {
      const d = orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop, e.closeKnee, e.crossY);
      const p = verticalAnchor(e.fromPoint, e.toPoint, e.laneX, e.kneeTop, e.closeKnee, e.crossY);
      // On its lane (not the center, not the source column).
      expect(p.x).toBeCloseTo(e.laneX, 5);
      // RULE 1.
      assertLineAboveAndBelow(d, p, `emptyIf arm ${e.slot}`);
      // CENTERED: the line above ≈ the line below (within a corner-radius tolerance).
      const runs = verticalRuns(d).filter((r) => Math.abs(r.x - p.x) < 1e-6);
      const hit = runs.find((r) => p.y >= r.y0 - 1e-6 && p.y <= r.y1 + 1e-6)!;
      const above = p.y - hit.y0;
      const below = hit.y1 - p.y;
      expect(Math.abs(above - below)).toBeLessThanOrEqual(1e-6);
    }
  });

  it('the merge + sits on a PADDED central run (≥ PLUS_PAD above — NOT the old no-pad fallback)', () => {
    const { positions, edges } = emptyArmEdges();
    const join = positions.get('join')!;
    const anchor = mergeAnchor(edges, positions, 'join');
    expect(anchor.x).toBeCloseTo(join.x, 5);
    // The close corner is ABOVE the +; the + is above the join card — a real central run.
    expect(anchor.closureCornerY).toBeLessThan(anchor.y);
    expect(anchor.y).toBeLessThan(join.y);
    // ≥ PLUS_PAD above the + (the old fallback gave only 14px — far less than PLUS_PAD).
    expect(anchor.y - anchor.closureCornerY).toBeGreaterThanOrEqual(PLUS_PAD - 1e-6);
    // And it lands ON the central run of an arm's path with line above AND below (RULE 1).
    const closing = edges.find(
      (e) => e.to === 'join' && e.emptyArm === true && Math.abs(e.toPoint.x - join.x) < 1e-6,
    )!;
    const d = orthogonalPath(closing.fromPoint, closing.toPoint, closing.laneX, undefined, closing.kneeTop, closing.closeKnee, closing.crossY);
    assertLineAboveAndBelow(d, { x: anchor.x, y: anchor.y }, 'emptyIf merge +');
  });

  it('EVERY corner of an empty arm is ROUNDED — no square (bare axis flip / degenerate Q)', () => {
    const { arms } = emptyArmEdges();
    for (const e of arms) {
      const d = orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop, e.closeKnee, e.crossY);
      expect(d).not.toMatch(/\bL\b/); // no straight-diagonal segment
      // All FOUR outer corners (top-center, top-outer, bottom-outer, bottom-center) must be
      // genuine quarter-circles — a degenerate Q or a bare V↔H flip is a square corner.
      assertAllCornersRounded(d, `emptyIf arm ${e.slot}`);
      const qCount = d.trim().split(/\s+/).filter((t) => t === 'Q').length;
      expect(qCount).toBeGreaterThanOrEqual(4); // top-center + top-outer + bottom-outer + bottom-center
    }
  });

  it('the empty diamond stays a reasonable height (not absurdly tall)', () => {
    const { height } = layoutDefinition(emptyIf);
    // trigger → cond → join → exit is 4 rows; with the merge drop it must stay sane.
    expect(height).toBeLessThan(1200);
  });
});

describe('preserved invariants over all fixtures (down-only, axis-aligned)', () => {
  for (const [name, def] of ALL_FIXTURES) {
    it(`${name}: every edge is down-only and diagonal-free`, () => {
      const { positions } = layoutDefinition(def);
      const edges = computeEdges(def, positions);
      for (const e of edges) {
        expect(e.toPoint.y, `${name} ${e.from}->${e.to}`).toBeGreaterThan(e.fromPoint.y);
        const d = orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop, e.closeKnee, e.crossY);
        expect(d, `${name} ${e.from}->${e.to}`).not.toMatch(/\bL\b/);
      }
    });
  }

  // CONTOUR PACKING (the user's "narrow it down where there's space") must NEVER let two
  // cards at the SAME depth overlap — they keep ≥ one column (the compact gap) apart.
  for (const [name, def] of ALL_FIXTURES) {
    it(`${name}: no two cards at the same depth overlap (≥ 1 col apart)`, () => {
      const { positions } = layoutDefinition(def);
      const byDepth = new Map<number, number[]>();
      for (const p of positions.values()) (byDepth.get(p.depth) ?? byDepth.set(p.depth, []).get(p.depth)!).push(p.x);
      for (const xs of byDepth.values()) {
        xs.sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) {
          expect(xs[i]! - xs[i - 1]!, `${name} depth-overlap`).toBeGreaterThanOrEqual(LAYOUT.colWidth - 1e-6);
        }
      }
    });
  }
});

describe('contour packing tightens a linear top above a deep branch (v0.90.0)', () => {
  it('a linear chain leading to a DEEP If hugs the trunk — it does NOT reserve the deep width at the top', () => {
    const def: AutomationDefinition = {
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
        cond: { type: 'condition', ast: { field: 'a', operator: '=', value: 'v' }, onTrue: 'chain1', onFalse: 'sendN' },
        chain1: { type: 'action', kind: 'send', template_id: 't1', next: 'chain2' },
        chain2: { type: 'action', kind: 'send', template_id: 't2', next: 'deepIf' },
        deepIf: { type: 'condition', ast: { field: 'x', operator: '=', value: '1' }, onTrue: 'da', onFalse: 'db' },
        da: { type: 'action', kind: 'send', template_id: 'tda', next: 'exitA' },
        db: { type: 'action', kind: 'send', template_id: 'tdb', next: 'exitB' },
        exitA: { type: 'exit' },
        exitB: { type: 'exit' },
        sendN: { type: 'action', kind: 'send', template_id: 'tN', next: 'exitN' },
        exitN: { type: 'exit' },
      },
    };
    const { positions } = layoutDefinition(def);
    const cond = positions.get('cond')!;
    // The linear top of the arm (chain1) sits at the COMPACT ±BRANCH_HALF_GAP — NOT pushed
    // out by the deep If's width below it (the bug: the deep branch reserved width all the
    // way up, flinging the linear top far from the trunk).
    expect(Math.abs(positions.get('chain1')!.x - cond.x)).toBeCloseTo(BRANCH_HALF_GAP, 5);
    // The linear chain stays STRAIGHT (chain1, chain2, deepIf share one column).
    expect(positions.get('chain2')!.x).toBeCloseTo(positions.get('chain1')!.x, 5);
    expect(positions.get('deepIf')!.x).toBeCloseTo(positions.get('chain1')!.x, 5);
  });
});
