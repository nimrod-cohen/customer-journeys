// Unit: auto-layout (down-only tree, branch fan, diamond once) (§9B phase 5).
// Pure — positions are computed from edges, never read from the def.
import { describe, it, expect } from 'vitest';
import { layoutDefinition, subtreeWidth, computeEdges, type CampaignDefinition } from './layout.js';

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

describe('subtreeWidth', () => {
  it('a leaf is width 1; a branch sums its arms; a diamond counts shared once', () => {
    expect(subtreeWidth(linear, 'exit1')).toBe(1);
    expect(subtreeWidth(branch, 'cond')).toBe(2); // two leaf arms
    expect(subtreeWidth(diamond, 'cond')).toBe(2); // join counted once across arms
  });
});

describe('computeEdges', () => {
  it('emits one down-only edge per next/onTrue/onFalse', () => {
    const { positions } = layoutDefinition(branch);
    const edges = computeEdges(branch, positions);
    expect(edges.length).toBe(5); // trigger→cond, cond→Y, cond→N, Y→exitY, N→exitN
    for (const e of edges) expect(e.toPoint.y).toBeGreaterThan(e.fromPoint.y);
    const condEdges = edges.filter((e) => e.from === 'cond');
    expect(condEdges.map((e) => e.label).sort()).toEqual(['No', 'Yes']);
  });
});
