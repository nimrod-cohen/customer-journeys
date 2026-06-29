// Unit: a join shared by NESTED Ifs STAGGERS its closing levels so there is room — and a
// correctly-placed merge (+) — to add a step AFTER the inner If's closure but BEFORE the
// outer If's closure (the user's spec). Guarded to multi-owner joins; single-If geometry
// is covered by layout.test.ts / branch-invariants.test.ts (unchanged).
import { describe, it, expect } from 'vitest';
import { layoutDefinition, mergeAnchor, NESTED_LEVEL_DROP, type CampaignDefinition } from './layout.js';
import { MIN_SEGMENT } from './orthogonal-path.js';
import { parseDefinition, buildDefinition } from './model.js';
import { branchContinuation, insertAfterBranch } from './mutate.js';

// outer If "earlier": onTrue → set_dow → inner If "saturday" → hw1/hw2 → exit
//                     onFalse → wait1 → exit   (both Ifs rejoin the SAME exit)
const NESTED: CampaignDefinition = {
  startNode: 'trig',
  nodes: {
    trig: { id: 'trig', type: 'trigger', kind: 'manual', next: 'earlier' } as never,
    earlier: { id: 'earlier', type: 'condition', onTrue: 'set_dow', onFalse: 'wait1' } as never,
    set_dow: { id: 'set_dow', type: 'action', kind: 'set_attribute', key: 'd', value: { kind: 'literal', value: 'x' }, next: 'saturday' } as never,
    saturday: { id: 'saturday', type: 'condition', onTrue: 'hw1', onFalse: 'hw2' } as never,
    hw1: { id: 'hw1', type: 'hour_of_day_window', startMin: 1200, endMin: 1440, next: 'exit' } as never,
    hw2: { id: 'hw2', type: 'hour_of_day_window', startMin: 420, endMin: 1440, next: 'exit' } as never,
    wait1: { id: 'wait1', type: 'wait', delay: { amount: 60, unit: 'hours' }, next: 'exit' } as never,
    exit: { id: 'exit', type: 'exit' } as never,
  },
};

describe('nested-If shared join staggers the close levels', () => {
  it('the inner arms close ONE level higher than the outer arm', () => {
    const layout = layoutDefinition(NESTED);
    const inner = layout.edges.filter((e) => (e.from === 'hw1' || e.from === 'hw2') && e.to === 'exit');
    const outer = layout.edges.find((e) => e.from === 'wait1' && e.to === 'exit')!;
    // Both inner arms share ONE close level (RULE 2 within the inner If).
    const innerCross = inner[0]!.crossY!;
    expect(innerCross).toBe(inner[1]!.crossY);
    // The inner (deeper) If closes HIGHER (smaller y) than the outer arm, by exactly one level.
    expect(outer.crossY! - innerCross).toBe(NESTED_LEVEL_DROP);
  });

  it("the inner merge (+) sits BETWEEN the inner closure and the outer arm's join", () => {
    const layout = layoutDefinition(NESTED);
    const outer = layout.edges.find((e) => e.from === 'wait1' && e.to === 'exit')!;
    const anchor = mergeAnchor(layout.edges, layout.positions, 'exit');
    // Above the closure corner (a visible line above the +)…
    expect(anchor.y).toBeGreaterThan(anchor.closureCornerY);
    // …and strictly ABOVE where the outer arm joins (so it's "after inner, before outer").
    expect(anchor.y).toBeLessThan(outer.crossY!);
    // RULE 1: room for a line above AND below the + (≥ ~MIN_SEGMENT of run around it).
    expect(outer.crossY! - anchor.closureCornerY).toBeGreaterThanOrEqual(MIN_SEGMENT);
  });

  it('clicking the inner merge (+) adds a step AFTER the inner closure, leaving the outer arm direct', () => {
    const model = parseDefinition(NESTED);
    // Before: both Ifs share the SAME continuation (exit) — fused.
    expect(branchContinuation(model, 'saturday')).toBe('exit');
    expect(branchContinuation(model, 'earlier')).toBe('exit');

    const after = parseDefinition(buildDefinition(insertAfterBranch(model, 'saturday', 'wait')));
    const def = buildDefinition(after);
    // The inner arms now flow through the new node; the outer arm still goes straight to exit.
    const newId = Object.keys(def.nodes).find((id) => id.startsWith('wait_'))!;
    const nextOf = (id: string): string | undefined => (def.nodes[id] as { next?: string }).next;
    expect(nextOf('hw1')).toBe(newId);
    expect(nextOf('hw2')).toBe(newId);
    expect(nextOf('wait1')).toBe('exit');
    // Continuations are now DISTINCT — the merges have separated.
    expect(branchContinuation(after, 'saturday')).toBe(newId);
    expect(branchContinuation(after, 'earlier')).toBe('exit');
  });
});
