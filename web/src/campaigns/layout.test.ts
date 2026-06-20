// Unit: auto-layout (down-only tree, branch fan, diamond once) (§9B phase 5).
// Pure — positions are computed from edges, never read from the def.
import { describe, it, expect } from 'vitest';
import { layoutDefinition, mergeAnchor, subtreeWidth, computeEdges, LAYOUT, BRANCH_HALF_GAP, type CampaignDefinition } from './layout.js';
import { orthogonalPath, verticalAnchor, MIN_SEGMENT } from './orthogonal-path.js';

/** Count the HORIZONTAL jogs (knees) in a path `d` — each H run is one knee. */
function horizontalKnees(d: string): number {
  return d.trim().split(/\s+/).filter((t) => t === 'H').length;
}

/** Collect the VERTICAL runs of an SVG path `d` as {x, y0, y1} (y0<y1). */
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

/** The height of the tallest vertical run on which `p` lies (null if none). */
function anchorRunHeight(d: string, p: { x: number; y: number }): number | null {
  const hits = verticalRuns(d).filter(
    (r) => Math.abs(r.x - p.x) < 1e-6 && p.y >= r.y0 - 1e-6 && p.y <= r.y1 + 1e-6,
  );
  if (hits.length === 0) return null;
  return Math.max(...hits.map((r) => r.y1 - r.y0));
}

const linear: CampaignDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'segment_entry', next: 'wait1' },
    wait1: { type: 'wait', delay: { seconds: 172800 }, next: 'send1' },
    send1: { type: 'action', kind: 'send', template_id: 'tpl', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

const branch: CampaignDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'sendY', onFalse: 'sendN' },
    sendY: { type: 'action', kind: 'send', template_id: 'tplY', next: 'exitY' },
    sendN: { type: 'action', kind: 'send', template_id: 'tplN', next: 'exitN' },
    exitY: { type: 'exit' },
    exitN: { type: 'exit' },
  },
};

// A diamond: condition's two arms re-converge on a single downstream node.
const diamond: CampaignDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'a', onFalse: 'b' },
    a: { type: 'action', kind: 'set_attribute', key: 'k', value: '1', next: 'join' },
    b: { type: 'action', kind: 'set_attribute', key: 'k', value: '2', next: 'join' },
    join: { type: 'action', kind: 'set_attribute', key: 'done', value: 'y', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

// The USER case: one populated arm (cond.onTrue→a→join) + one EMPTY arm
// (cond.onFalse→join directly), both rejoining a single trunk that exits.
const emptyArmDiamond: CampaignDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'a', onFalse: 'join' },
    a: { type: 'action', kind: 'send', template_id: 'tplA', next: 'join' },
    join: { type: 'exit' },
  },
};

// A FULLY empty diamond: both arms point straight at the directly-below join.
const fullyEmptyDiamond: CampaignDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'join', onFalse: 'join' },
    join: { type: 'exit' },
  },
};

// The USER's reported case: a branch that MERGES, then the trunk CONTINUES with a
// single-out chain (join → webhook → exit). Every post-merge node must sit STRAIGHT
// below the join (same x) — no spurious knee / re-centering toward the board center.
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

// UNEQUAL ARMS (v0.41.9): the Yes arm has ONE node (sendY), the No arm has THREE
// (waitN → hookN → sendN); both arms then MERGE on `join` and the trunk continues to a
// final webhook. The SHORT arm's closing edge (sendY → join) spans the empty tail down
// to the merge depth set by the LONG arm — its append-(+) must NOT drift down that tail.
const unequalArms: CampaignDefinition = {
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

describe('unequal-arm branch: each arm append-+ sits right after its last node, far from the merge +', () => {
  it('the SHORT (Yes) arm + sits just below its last node — NOT drifted down the empty tail', () => {
    const { positions } = layoutDefinition(unequalArms);
    const edges = computeEdges(unequalArms, positions);
    const sendY = positions.get('sendY')!;
    const closing = edges.find((e) => e.from === 'sendY' && e.to === 'join')!;
    expect(closing.closeKnee).toBe(true);
    const plus = verticalAnchor(closing.fromPoint, closing.toPoint, closing.laneX, closing.kneeTop, closing.closeKnee);
    // + is on the short arm's own column, just below the card bottom (within a normal
    // trunk gap), NOT down near the far-below merge depth.
    expect(plus.x).toBeCloseTo(sendY.x, 5);
    const normalGap = LAYOUT.rowHeight - LAYOUT.cardHeight;
    const cardBottom = sendY.y + LAYOUT.cardHeight;
    expect(plus.y).toBeGreaterThan(cardBottom - 1e-6); // below the card
    expect(plus.y - cardBottom).toBeLessThan(normalGap); // within one trunk gap
  });

  it('each arm has EXACTLY ONE append-+ and it is clearly separated from the merge + (≥ MIN_SEGMENT)', () => {
    const { positions } = layoutDefinition(unequalArms);
    const edges = computeEdges(unequalArms, positions);
    const mergePlus = mergeAnchor(edges, positions, 'join');
    for (const armLast of ['sendY', 'sendN'] as const) {
      const closings = edges.filter((e) => e.from === armLast && e.to === 'join');
      expect(closings.length, `${armLast} should have exactly one closing edge`).toBe(1);
      const plus = verticalAnchor(closings[0]!.fromPoint, closings[0]!.toPoint, closings[0]!.laneX, closings[0]!.kneeTop, closings[0]!.closeKnee);
      // The arm + is HIGH (above the merge +) and separated by ≥ MIN_SEGMENT.
      expect(plus.y, `${armLast} + below merge +`).toBeLessThan(mergePlus.y);
      expect(mergePlus.y - plus.y, `${armLast} + adjacent to merge +`).toBeGreaterThanOrEqual(MIN_SEGMENT);
    }
  });

  it('the short arm tail between its + and the close knee is a PLAIN vertical with NO second +', () => {
    const { positions } = layoutDefinition(unequalArms);
    const edges = computeEdges(unequalArms, positions);
    // Only ONE edge leaves the short arm's last node, so only ONE edge-+ exists on it.
    const sendYEdges = edges.filter((e) => e.from === 'sendY');
    expect(sendYEdges.length).toBe(1);
    // Its path: a single closing jog (one knee) — the tail below the + down to the
    // close knee is a single uninterrupted vertical run (no branch / no extra control).
    const d = orthogonalPath(sendYEdges[0]!.fromPoint, sendYEdges[0]!.toPoint, sendYEdges[0]!.laneX, undefined, sendYEdges[0]!.kneeTop, sendYEdges[0]!.closeKnee);
    expect(horizontalKnees(d)).toBe(1); // exactly one knee (the close knee at the bottom)
  });

  it('the merge + stays on the central post-convergence run with a line above and below (v0.41.8)', () => {
    const { positions } = layoutDefinition(unequalArms);
    const edges = computeEdges(unequalArms, positions);
    const join = positions.get('join')!;
    const anchor = mergeAnchor(edges, positions, 'join');
    expect(anchor.x).toBeCloseTo(join.x, 5);
    expect(anchor.closureCornerY).toBeLessThan(anchor.y); // line ABOVE
    expect(anchor.y).toBeLessThan(join.y); // line BELOW (down to the card)
    // It is on a vertical run of a closing edge at join.x.
    const closing = edges.find((e) => e.to === 'join' && e.closeKnee === true && Math.abs(e.toPoint.x - join.x) < 1e-6)!;
    const d = orthogonalPath(closing.fromPoint, closing.toPoint, closing.laneX, undefined, closing.kneeTop, closing.closeKnee);
    const run = verticalRuns(d).find((r) => Math.abs(r.x - anchor.x) < 1e-6 && anchor.y >= r.y0 - 1e-6 && anchor.y <= r.y1 + 1e-6);
    expect(run, `merge + not on a vertical run of ${d}`).toBeTruthy();
  });

  it('all closing edges are still down-only and axis-aligned', () => {
    const { positions } = layoutDefinition(unequalArms);
    const edges = computeEdges(unequalArms, positions);
    for (const e of edges) {
      expect(e.toPoint.y).toBeGreaterThan(e.fromPoint.y); // down-only
      const d = orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop, e.closeKnee);
      expect(d).not.toMatch(/\bL\b/); // no diagonal
    }
  });
});

describe('single-out edges are STRAIGHT verticals (no spurious knee / re-centering)', () => {
  it('a single-out node places its child at the SAME x (straight vertical, no jog)', () => {
    const { positions } = layoutDefinition(linear);
    // Every linear edge is single-out → identical x already covered, re-assert per edge.
    const edges = computeEdges(linear, positions);
    for (const e of edges) {
      expect(e.fromPoint.x, `edge ${e.from}->${e.to}`).toBe(e.toPoint.x);
      expect(horizontalKnees(orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop))).toBe(0);
    }
  });

  it('the post-merge trunk follows the JOIN x: join → webhook → exit are all straight below the join', () => {
    const { positions } = layoutDefinition(mergeThenTrunk);
    const joinX = positions.get('join')!.x;
    // The whole downstream chain shares the (re-centered) join's column.
    expect(positions.get('webhook')!.x).toBe(joinX);
    expect(positions.get('exit1')!.x).toBe(joinX);
    // And the connectors are pure straight verticals (fromPoint.x === toPoint.x, no H).
    const edges = computeEdges(mergeThenTrunk, positions);
    for (const e of edges.filter((x) => ['join', 'webhook'].includes(x.from))) {
      expect(e.fromPoint.x, `edge ${e.from}->${e.to} not straight`).toBe(e.toPoint.x);
      expect(
        horizontalKnees(orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop)),
        `edge ${e.from}->${e.to} has a knee`,
      ).toBe(0);
    }
  });

  it('the join is centered under its two arms AND its downstream chain shares its x', () => {
    const { positions } = layoutDefinition(mergeThenTrunk);
    const ax = positions.get('a')!.x;
    const bx = positions.get('b')!.x;
    const joinX = positions.get('join')!.x;
    expect(joinX).toBeCloseTo((ax + bx) / 2, 5); // centered under the arms
    // Downstream inherits it (no pull back to start/center).
    expect(positions.get('webhook')!.x).toBe(joinX);
    expect(positions.get('exit1')!.x).toBe(joinX);
  });
});

describe('extra vertical room below a merge join', () => {
  it('the gap below a merge join (join → next) is LARGER than the normal trunk gap', () => {
    const { positions } = layoutDefinition(mergeThenTrunk);
    const normalGap = positions.get('cond')!.y - positions.get('trigger')!.y; // a normal single-out drop
    const belowJoin = positions.get('webhook')!.y - positions.get('join')!.y; // closure → next
    expect(belowJoin).toBeGreaterThan(normalGap);
    // Still a comfortable run for the (+) — well above MIN_SEGMENT.
    const edges = computeEdges(mergeThenTrunk, positions);
    const trunk = edges.find((e) => e.from === 'join' && e.to === 'webhook')!;
    const h = anchorRunHeight(
      orthogonalPath(trunk.fromPoint, trunk.toPoint, trunk.laneX, undefined, trunk.kneeTop),
      verticalAnchor(trunk.fromPoint, trunk.toPoint, trunk.laneX, trunk.kneeTop),
    );
    expect(h).not.toBeNull();
    expect(h!).toBeGreaterThanOrEqual(MIN_SEGMENT);
  });
});

describe('merge (+) spacing — a visible vertical line ABOVE the merge +', () => {
  // The arms must CLOSE (corner back into the central column) at a y clearly ABOVE
  // the merge (+); the (+) sits in the MIDDLE of the post-convergence run with a
  // non-zero line above AND below it. (v0.41.8)
  for (const [name, def] of [
    ['both-populated diamond', diamond],
    ['populated + empty arm', emptyArmDiamond],
    ['merge-then-trunk', mergeThenTrunk],
  ] as const) {
    it(`${name}: closure corner is ABOVE the merge + with a real gap, + centered on the run`, () => {
      const { positions } = layoutDefinition(def);
      const edges = computeEdges(def, positions);
      const join = positions.get('join')!;
      const anchor = mergeAnchor(edges, positions, 'join');

      // The merge (+) anchors on the join's central column.
      expect(anchor.x).toBeCloseTo(join.x, 5);
      // The arms close (corner in) at a y STRICTLY above the (+), by ≥ half MIN_SEGMENT.
      expect(anchor.closureCornerY).toBeLessThan(anchor.y - MIN_SEGMENT / 2);
      // The (+) sits ABOVE the join card top (a line runs from + DOWN to the card).
      expect(anchor.y).toBeLessThan(join.y - MIN_SEGMENT / 2);

      // The (+) sits on a single VERTICAL run with NON-ZERO length both above & below.
      const closing = edges.find(
        (e) => e.to === 'join' && e.closeKnee === true && Math.abs(e.toPoint.x - join.x) < 1e-6,
      )!;
      const d = orthogonalPath(closing.fromPoint, closing.toPoint, closing.laneX, undefined, closing.kneeTop, closing.closeKnee);
      const run = verticalRuns(d).find(
        (r) => Math.abs(r.x - anchor.x) < 1e-6 && anchor.y >= r.y0 - 1e-6 && anchor.y <= r.y1 + 1e-6,
      );
      expect(run, `merge + not on a vertical run of ${d}`).toBeTruthy();
      expect(anchor.y - run!.y0).toBeGreaterThan(0); // line ABOVE the +
      expect(run!.y1 - anchor.y).toBeGreaterThan(0); // line BELOW the +
      // The whole convergence→join run clears the room a +-with-gaps needs.
      expect(run!.y1 - run!.y0).toBeGreaterThanOrEqual(MIN_SEGMENT);
    });
  }
});

describe('layoutDefinition', () => {
  it('places the trigger at depth 0 (smallest y)', () => {
    const { positions } = layoutDefinition(linear);
    const ys = [...positions.values()].map((p) => p.y);
    expect(positions.get('trigger')!.y).toBe(Math.min(...ys));
    expect(positions.get('trigger')!.depth).toBe(0);
  });

  it('every child is strictly below its parent (down-only)', () => {
    for (const def of [linear, branch, diamond]) {
      const { positions } = layoutDefinition(def);
      for (const id of Object.keys(def.nodes)) {
        const node = def.nodes[id]!;
        const targets =
          node.type === 'condition'
            ? [node.onTrue as string, node.onFalse as string]
            : node.type === 'exit'
              ? []
              : [node.next as string];
        for (const t of targets) {
          expect(positions.get(t)!.y).toBeGreaterThan(positions.get(id)!.y);
        }
      }
    }
  });

  it('a linear chain shares one x column (no horizontal spread)', () => {
    const { positions } = layoutDefinition(linear);
    const xs = [...positions.values()].map((p) => p.x);
    expect(new Set(xs).size).toBe(1);
    // y strictly increases down the chain.
    expect(positions.get('wait1')!.y).toBeGreaterThan(positions.get('trigger')!.y);
    expect(positions.get('send1')!.y).toBeGreaterThan(positions.get('wait1')!.y);
  });

  it("a condition's two arms land in distinct x columns (fanned sideways)", () => {
    const { positions } = layoutDefinition(branch);
    expect(positions.get('sendY')!.x).not.toBe(positions.get('sendN')!.x);
    // The condition sits between (centered over) its arms.
    const lo = Math.min(positions.get('sendY')!.x, positions.get('sendN')!.x);
    const hi = Math.max(positions.get('sendY')!.x, positions.get('sendN')!.x);
    expect(positions.get('cond')!.x).toBeGreaterThanOrEqual(lo);
    expect(positions.get('cond')!.x).toBeLessThanOrEqual(hi);
  });

  it('sibling subtrees never share an (x,y) cell', () => {
    const { positions } = layoutDefinition(branch);
    const cells = [...positions.values()].map((p) => `${p.x},${p.y}`);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('a diamond join is placed once, below BOTH parents (max depth + 1)', () => {
    const { positions } = layoutDefinition(diamond);
    const join = positions.get('join')!;
    expect(join.y).toBeGreaterThan(positions.get('a')!.y);
    expect(join.y).toBeGreaterThan(positions.get('b')!.y);
    expect(join.depth).toBe(Math.max(positions.get('a')!.depth, positions.get('b')!.depth) + 1);
    // Single entry — no duplicate position key.
    expect([...positions.keys()].filter((k) => k === 'join').length).toBe(1);
  });

  it('empty-arm diamond: the join is placed ONCE below BOTH the populated arm and the condition', () => {
    const { positions } = layoutDefinition(emptyArmDiamond);
    const join = positions.get('join')!;
    // depth = max(depth(a), depth(cond))+1 via longest-path. The populated arm `a`
    // is the deeper parent (cond→a→join), so the join sits below it AND the cond.
    expect(join.y).toBeGreaterThan(positions.get('a')!.y);
    expect(join.y).toBeGreaterThan(positions.get('cond')!.y);
    expect(join.depth).toBe(Math.max(positions.get('a')!.depth, positions.get('cond')!.depth) + 1);
    expect([...positions.keys()].filter((k) => k === 'join').length).toBe(1);
  });

  it('recenterJoins centers the join at the average of its two parents’ columns', () => {
    const { positions } = layoutDefinition(emptyArmDiamond);
    // The join’s parents are `a` (populated arm) and `cond` (the empty onFalse arm
    // points straight at the join).
    const px = [positions.get('a')!.x, positions.get('cond')!.x];
    const lo = Math.min(...px);
    const hi = Math.max(...px);
    const join = positions.get('join')!;
    expect(join.x).toBeGreaterThanOrEqual(lo);
    expect(join.x).toBeLessThanOrEqual(hi);
    expect(join.x).toBeCloseTo((lo + hi) / 2, 5);
  });

  it('computeEdges emits one down-only edge PER incoming edge into the join', () => {
    const { positions } = layoutDefinition(emptyArmDiamond);
    const edges = computeEdges(emptyArmDiamond, positions);
    const intoJoin = edges.filter((e) => e.to === 'join');
    expect(intoJoin.length).toBe(2); // from `a` and from `cond` (onFalse)
    for (const e of edges) expect(e.toPoint.y).toBeGreaterThan(e.fromPoint.y); // strictly down-only
  });

  it('subtreeWidth does not double-spread the shared join (≤ the arm count)', () => {
    // cond fans onTrue→a→join and onFalse→join; the join is a single shared leaf,
    // so the condition's width must not exceed its two arms (no extra spread from
    // counting the join twice). The empty arm contributes no extra column beyond
    // the join it shares with the populated arm.
    const w = subtreeWidth(emptyArmDiamond, 'cond');
    expect(w).toBeLessThanOrEqual(2);
    expect(w).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic + ignores any stored coordinates on the def', () => {
    const a = layoutDefinition(branch);
    const b = layoutDefinition(branch);
    expect([...a.positions.entries()]).toEqual([...b.positions.entries()]);
    // Inject bogus x/y → identical output (positions come from edges only).
    const polluted = JSON.parse(JSON.stringify(branch)) as CampaignDefinition;
    for (const id of Object.keys(polluted.nodes)) {
      (polluted.nodes[id] as Record<string, unknown>).x = 999;
      (polluted.nodes[id] as Record<string, unknown>).y = -999;
    }
    const c = layoutDefinition(polluted);
    expect([...c.positions.entries()]).toEqual([...a.positions.entries()]);
  });
});

describe('min vertical-segment floor (every (+) has room)', () => {
  const cases: Array<[string, CampaignDefinition]> = [
    ['linear', linear],
    ['branch', branch],
    ['diamond', diamond],
    ['emptyArmDiamond', emptyArmDiamond],
    ['fullyEmptyDiamond', fullyEmptyDiamond],
  ];

  it('the laid-out drop between adjacent depths comfortably exceeds MIN_SEGMENT', () => {
    const drop = LAYOUT.rowHeight - LAYOUT.cardHeight;
    expect(drop).toBeGreaterThanOrEqual(MIN_SEGMENT);
    // With margin for the rail insets the worst case still clears the floor.
    expect(drop).toBeGreaterThan(MIN_SEGMENT + 8);
  });

  for (const [name, def] of cases) {
    it(`${name}: EVERY edge's (+) anchor lies on a vertical run ≥ MIN_SEGMENT`, () => {
      const { positions } = layoutDefinition(def);
      const edges = computeEdges(def, positions);
      for (const e of edges) {
        const d = orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop);
        const a = verticalAnchor(e.fromPoint, e.toPoint, e.laneX, e.kneeTop);
        const h = anchorRunHeight(d, a);
        expect(h, `edge ${e.from}->${e.to} (${e.slot}) anchor not on a run; d=${d}`).not.toBeNull();
        expect(
          h!,
          `edge ${e.from}->${e.to} (${e.slot}) anchor run ${h} < ${MIN_SEGMENT}; d=${d}`,
        ).toBeGreaterThanOrEqual(MIN_SEGMENT);
      }
    });
  }

  it("a condition's two arm (+) anchors are at DISTINCT x AND each on a run ≥ MIN_SEGMENT", () => {
    for (const def of [branch, diamond, emptyArmDiamond, fullyEmptyDiamond]) {
      const { positions } = layoutDefinition(def);
      const edges = computeEdges(def, positions);
      const cond = Object.entries(def.nodes).find(([, n]) => n.type === 'condition')![0];
      const arms = edges.filter((e) => e.from === cond);
      expect(arms.length).toBe(2);
      const anchors = arms.map((e) => verticalAnchor(e.fromPoint, e.toPoint, e.laneX, e.kneeTop));
      expect(anchors[0]!.x).not.toBe(anchors[1]!.x); // distinct lanes — no stacking
      for (const e of arms) {
        const h = anchorRunHeight(orthogonalPath(e.fromPoint, e.toPoint, e.laneX, undefined, e.kneeTop), verticalAnchor(e.fromPoint, e.toPoint, e.laneX, e.kneeTop));
        expect(h).not.toBeNull();
        expect(h!).toBeGreaterThanOrEqual(MIN_SEGMENT);
      }
    }
  });

  it("an arm's (+) sits HIGH (well above) the merge (+) on the merged trunk — they never adjoin", () => {
    // diamond: cond → a → join, cond → b → join, join → exit1. The merge (+) sits on
    // the trunk just above the join (contPos.y − 14, per CampaignCanvas). Every arm's
    // (+) must be well above (smaller y) that merge (+), with a clear gap.
    const { positions } = layoutDefinition(diamond);
    const edges = computeEdges(diamond, positions);
    const joinPos = positions.get('join')!;
    const mergeInsertY = joinPos.y - 14; // the merge (+) anchor y in CampaignCanvas
    const arms = edges.filter((e) => e.from === 'cond');
    expect(arms.length).toBe(2);
    for (const e of arms) {
      const a = verticalAnchor(e.fromPoint, e.toPoint, e.laneX, e.kneeTop);
      // The arm (+) is HIGH — straight below the condition, far above the merge (+).
      expect(a.y).toBeLessThan(mergeInsertY - 40);
    }
  });

  it('the merged trunk after a branch (join → continuation) is a vertical run ≥ MIN_SEGMENT', () => {
    // diamond: join → exit1 is the merged trunk continuation edge.
    const { positions } = layoutDefinition(diamond);
    const edges = computeEdges(diamond, positions);
    const trunk = edges.find((e) => e.from === 'join' && e.to === 'exit1')!;
    const h = anchorRunHeight(
      orthogonalPath(trunk.fromPoint, trunk.toPoint, trunk.laneX, undefined, trunk.kneeTop),
      verticalAnchor(trunk.fromPoint, trunk.toPoint, trunk.laneX, trunk.kneeTop),
    );
    expect(h).not.toBeNull();
    expect(h!).toBeGreaterThanOrEqual(MIN_SEGMENT);
  });
});

describe('subtreeWidth', () => {
  it('a leaf is width 1; a branch sums its arms; a diamond counts shared once', () => {
    expect(subtreeWidth(linear, 'exit1')).toBe(1);
    expect(subtreeWidth(branch, 'cond')).toBe(2); // two leaf arms
    expect(subtreeWidth(diamond, 'cond')).toBe(2); // join counted once across arms
  });
});

describe('computeEdges (lane routing)', () => {
  it('a FULLY empty diamond gives its two arms DISTINCT lane x (no stacked +s)', () => {
    const { positions } = layoutDefinition(fullyEmptyDiamond);
    const edges = computeEdges(fullyEmptyDiamond, positions);
    const yes = edges.find((e) => e.from === 'cond' && e.slot === 'onTrue')!;
    const no = edges.find((e) => e.from === 'cond' && e.slot === 'onFalse')!;
    // The join sits directly below the condition (same column) — so each arm needs
    // its OWN side lane; the two lane x's must differ (onTrue left, onFalse right).
    expect(yes.toPoint.x).toBe(no.toPoint.x); // still CONVERGE on the same join
    expect(yes.laneX).not.toBe(no.laneX); // but route down distinct vertical lanes
    expect(yes.laneX).toBeLessThan(no.laneX); // Yes left of No
  });

  it('a POPULATED arm routes down its CHILD column (laneX === child x, single TOP knee) — the (+) and child share the column', () => {
    const { positions } = layoutDefinition(branch);
    const edges = computeEdges(branch, positions);
    const yes = edges.find((e) => e.from === 'cond' && e.slot === 'onTrue')!;
    const no = edges.find((e) => e.from === 'cond' && e.slot === 'onFalse')!;
    // The lane IS the child's column (no separate side-lane) — so the single knee is
    // at the TOP and the (+) anchors straight ABOVE the child on that same column x.
    expect(yes.laneX).toBe(positions.get('sendY')!.x);
    expect(no.laneX).toBe(positions.get('sendN')!.x);
    expect(yes.kneeTop).toBe(true);
    expect(no.kneeTop).toBe(true);
    // The (+) anchor x equals the child's column x (NOT a separate lane).
    const yesA = verticalAnchor(yes.fromPoint, yes.toPoint, yes.laneX, yes.kneeTop);
    const noA = verticalAnchor(no.fromPoint, no.toPoint, no.laneX, no.kneeTop);
    expect(yesA.x).toBe(positions.get('sendY')!.x);
    expect(noA.x).toBe(positions.get('sendN')!.x);
    expect(yesA.x).not.toBe(noA.x);
    // Exactly ONE horizontal knee at the top of each arm connector.
    expect(horizontalKnees(orthogonalPath(yes.fromPoint, yes.toPoint, yes.laneX, undefined, yes.kneeTop))).toBe(1);
    expect(horizontalKnees(orthogonalPath(no.fromPoint, no.toPoint, no.laneX, undefined, no.kneeTop))).toBe(1);
  });

  it('the two arm columns sit at center ± BRANCH_HALF_GAP (compact, not edge-spread)', () => {
    const { positions } = layoutDefinition(branch);
    const cond = positions.get('cond')!;
    const yesX = positions.get('sendY')!.x;
    const noX = positions.get('sendN')!.x;
    const left = Math.min(yesX, noX);
    const right = Math.max(yesX, noX);
    expect(cond.x).toBeCloseTo((left + right) / 2, 5); // condition centered between
    expect(right - left).toBeCloseTo(2 * BRANCH_HALF_GAP, 5); // compact center-to-center
    // The gap between the two ~cardWidth cards is modest (positive but small).
    const cardGap = right - left - LAYOUT.cardWidth;
    expect(cardGap).toBeGreaterThan(0);
    expect(cardGap).toBeLessThan(LAYOUT.cardWidth); // not flung to the edges
  });

  it('all nodes stacked down ONE arm share the SAME column x (a straight vertical, no per-node jog)', () => {
    // cond.onTrue → a → a2 → join: the arm has TWO stacked nodes; both share one x.
    const stacked: CampaignDefinition = {
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
        cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'a', onFalse: 'join' },
        a: { type: 'action', kind: 'send', template_id: 't', next: 'a2' },
        a2: { type: 'wait', delay: { seconds: 86400 }, next: 'join' },
        join: { type: 'exit' },
      },
    };
    const { positions } = layoutDefinition(stacked);
    expect(positions.get('a')!.x).toBe(positions.get('a2')!.x); // same straight column
    // The a → a2 edge is a single straight vertical (no horizontal knee).
    const edges = computeEdges(stacked, positions);
    const inner = edges.find((e) => e.from === 'a' && e.to === 'a2')!;
    expect(horizontalKnees(orthogonalPath(inner.fromPoint, inner.toPoint, inner.laneX, undefined, inner.kneeTop))).toBe(0);
  });

  it('emits one down-only edge per next/onTrue/onFalse', () => {
    const { positions } = layoutDefinition(branch);
    const edges = computeEdges(branch, positions);
    expect(edges.length).toBe(5); // trigger→cond, cond→Y, cond→N, Y→exitY, N→exitN
    for (const e of edges) expect(e.toPoint.y).toBeGreaterThan(e.fromPoint.y);
    const condEdges = edges.filter((e) => e.from === 'cond');
    expect(condEdges.map((e) => e.label).sort()).toEqual(['No', 'Yes']);
  });
});
