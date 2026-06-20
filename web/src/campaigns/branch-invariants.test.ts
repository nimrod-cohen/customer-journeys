// Unit: the TWO first-class branch-rendering invariants (v0.42.0).
//
//  RULE 1 — EVERY `+` HAS A LINE ABOVE AND BELOW IT (≥ PLUS_PAD px each side).
//    Every `+` insertion control (campaign-edge-insert AND campaign-merge-insert) is
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
  type CampaignDefinition,
} from './layout.js';
import { orthogonalPath, verticalAnchor, MIN_SEGMENT } from './orthogonal-path.js';

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
 * RULE 1 oracle — assert anchor `p` sits on ONE vertical run of `d` that spans at
 * least [p.y - PLUS_PAD, p.y + PLUS_PAD] (line above AND below, no corner within
 * PLUS_PAD). Returns nothing; throws via expect on failure.
 */
function assertLineAboveAndBelow(d: string, p: { x: number; y: number }, label: string): void {
  const runs = verticalRuns(d).filter((r) => Math.abs(r.x - p.x) < 1e-6);
  const hit = runs.find((r) => p.y >= r.y0 - 1e-6 && p.y <= r.y1 + 1e-6);
  expect(hit, `${label}: + anchor ${JSON.stringify(p)} not on a vertical run of ${d}`).toBeTruthy();
  expect(p.y - hit!.y0, `${label}: < PLUS_PAD line ABOVE the + (above=${(p.y - hit!.y0).toFixed(1)})`).toBeGreaterThanOrEqual(
    PLUS_PAD - 1e-6,
  );
  expect(hit!.y1 - p.y, `${label}: < PLUS_PAD line BELOW the + (below=${(hit!.y1 - p.y).toFixed(1)})`).toBeGreaterThanOrEqual(
    PLUS_PAD - 1e-6,
  );
}

// ---- Fixtures: a spread of graph shapes -----------------------------------

const linear: CampaignDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'segment_entry', next: 'wait1' },
    wait1: { type: 'wait', delay: { seconds: 172800 }, next: 'send1' },
    send1: { type: 'action', kind: 'send', template_id: 'tpl', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

// Equal arms: each arm has exactly ONE node, then merge → trunk.
const equalArms: CampaignDefinition = {
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

// Yes=1, No=3: the SHORT arm (Yes) must extend straight down to the LONG arm's end.
const yes1no3: CampaignDefinition = {
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
const no1yes3: CampaignDefinition = {
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
const nestedInArm: CampaignDefinition = {
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
const mergeThenTrunk: CampaignDefinition = {
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

const ALL_FIXTURES: Array<[string, CampaignDefinition]> = [
  ['linear', linear],
  ['equalArms', equalArms],
  ['yes1no3', yes1no3],
  ['no1yes3', no1yes3],
  ['nestedInArm', nestedInArm],
  ['mergeThenTrunk', mergeThenTrunk],
];

/** Every `+` anchor in a layout: edge-insert anchors + merge-insert anchors. */
function allPlusAnchors(def: CampaignDefinition): Array<{ label: string; d: string; p: { x: number; y: number } }> {
  const { positions, edges } = layoutDefinition(def);
  const out: Array<{ label: string; d: string; p: { x: number; y: number } }> = [];
  // campaign-edge-insert: one per layout edge.
  for (const e of edges) {
    const d = orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop, e.closeKnee, e.crossY);
    const p = verticalAnchor(e.fromPoint, e.toPoint, e.laneX, e.kneeTop, e.closeKnee, e.crossY);
    out.push({ label: `edge-insert ${e.from}->${e.to} (${e.slot})`, d, p });
  }
  // campaign-merge-insert: one per join that close-knee edges converge on (the central
  // run the merge + sits on). Mirrors CampaignCanvas's merge-insert anchoring.
  const joinIds = new Set(edges.filter((e) => e.closeKnee === true).map((e) => e.to));
  for (const joinId of joinIds) {
    const join = positions.get(joinId);
    const anchor = mergeAnchor(edges, positions, joinId);
    const closing = edges.find(
      (e) => e.to === joinId && e.closeKnee === true && join !== undefined && Math.abs(e.toPoint.x - join.x) < 1e-6,
    );
    if (!closing) continue;
    const d = orthogonalPath(closing.fromPoint, closing.toPoint, closing.laneX, undefined, closing.kneeTop, closing.closeKnee, closing.crossY);
    out.push({ label: `merge-insert @${joinId}`, d, p: { x: anchor.x, y: anchor.y } });
  }
  return out;
}

describe('RULE 1 — every + has ≥ PLUS_PAD line ABOVE and BELOW it', () => {
  it('PLUS_PAD and MIN_SEGMENT are sized so a line+`+`+line run always fits', () => {
    const plusDiameter = 28;
    expect(MIN_SEGMENT).toBeGreaterThanOrEqual(2 * PLUS_PAD + plusDiameter);
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

describe('RULE 2 — equal arm heights; knee back only at the longer arm’s end', () => {
  /** The arm-leaf → join closing edges for a given join. */
  function closingsInto(def: CampaignDefinition, joinId: string): ReturnType<typeof computeEdges> {
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
});
