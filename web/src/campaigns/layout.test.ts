// Unit: auto-layout (down-only tree, branch fan, diamond once) (§9B phase 5).
// Pure — positions are computed from edges, never read from the def.
import { describe, it, expect } from 'vitest';
import { layoutDefinition, subtreeWidth, computeEdges, LAYOUT, BRANCH_HALF_GAP, type CampaignDefinition } from './layout.js';
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
