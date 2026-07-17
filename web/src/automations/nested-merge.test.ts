// Unit: a join shared by NESTED Ifs STAGGERS its closing levels so there is room — and a
// correctly-placed merge (+) — to add a step AFTER the inner If's closure but BEFORE the
// outer If's closure (the user's spec). Guarded to multi-owner joins; single-If geometry
// is covered by layout.test.ts / branch-invariants.test.ts (unchanged).
import { describe, it, expect } from 'vitest';
import { layoutDefinition, mergeAnchor, conditionMergeAnchors, NESTED_LEVEL_DROP, type AutomationDefinition } from './layout.js';
import { MIN_SEGMENT } from './orthogonal-path.js';
import { parseDefinition, buildDefinition } from './model.js';
import { branchContinuation, insertAfterBranch, moveAfterBranch, canPlaceAfterBranch } from './mutate.js';

// outer If "earlier": onTrue → set_dow → inner If "saturday" → hw1/hw2 → exit
//                     onFalse → wait1 → exit   (both Ifs rejoin the SAME exit)
const NESTED: AutomationDefinition = {
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

  it('renders a merge (+) for BOTH the inner AND the outer If, at DISTINCT positions', () => {
    const layout = layoutDefinition(NESTED);
    const anchors = conditionMergeAnchors(buildDefinition(parseDefinition(NESTED)), layout.positions, layout.edges);
    // Both nested owners get their own merge (+) — the outer one is no longer dropped.
    expect(anchors.has('saturday')).toBe(true);
    expect(anchors.has('earlier')).toBe(true);
    const inner = anchors.get('saturday')!;
    const outer = anchors.get('earlier')!;
    // Distinct points (not stacked): the inner (+) sits clearly ABOVE the outer (+)
    // (each centered on its own sub-run, so the gap ≈ NESTED_LEVEL_DROP minus run slack).
    expect(outer.y - inner.y).toBeGreaterThan(MIN_SEGMENT);
    // The outer (+) sits below the outer arm's join (where wait1 closes) and above exit.
    const wait1 = layout.edges.find((e) => e.from === 'wait1' && e.to === 'exit')!;
    const exitY = layout.positions.get('exit')!.y;
    expect(outer.y).toBeGreaterThan(wait1.crossY!);
    expect(outer.y).toBeLessThan(exitY);
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

// MOVE placement now offers the merge (+) (after-branch) too — not just DUPLICATE — so a
// single node can be RELOCATED to run after a branch's convergence (the user's report:
// during Move, the "after the inner/outer convergence" drop spots were missing).
describe('move a node AFTER a branch convergence (moveAfterBranch)', () => {
  const nextOf = (def: ReturnType<typeof buildDefinition>, id: string): string | undefined =>
    (def.nodes[id] as { next?: string }).next;
  const onFalseOf = (def: ReturnType<typeof buildDefinition>, id: string): string | undefined =>
    (def.nodes[id] as { onFalse?: string }).onFalse;

  it('the merge (+) is offered for BOTH nested Ifs while moving a single node', () => {
    const model = parseDefinition(NESTED);
    // hw2 is the moving node; both the inner (saturday) and outer (earlier) merges accept it.
    expect(canPlaceAfterBranch(model, 'hw2', 'saturday', 'move')).toBe(true);
    expect(canPlaceAfterBranch(model, 'hw2', 'earlier', 'move')).toBe(true);
    // A CONDITION (branch root) can't be moved as a single step after a branch.
    expect(canPlaceAfterBranch(model, 'saturday', 'earlier', 'move')).toBe(false);
  });

  it('moving a node after the INNER convergence places it before the inner rejoin, outer arm untouched', () => {
    const model = parseDefinition(NESTED);
    const def = buildDefinition(moveAfterBranch(model, 'hw2', 'saturday'));
    // Both inner arms now flow through hw2 (its old No-arm slot is now empty → straight to hw2)…
    expect(nextOf(def, 'hw1')).toBe('hw2');
    expect(onFalseOf(def, 'saturday')).toBe('hw2');
    expect(nextOf(def, 'hw2')).toBe('exit');
    // …the outer arm (wait1) still joins at exit, BELOW hw2 (after inner, before outer).
    expect(nextOf(def, 'wait1')).toBe('exit');
  });

  it('moving a node after the OUTER convergence places it on the final trunk before exit', () => {
    const model = parseDefinition(NESTED);
    const def = buildDefinition(moveAfterBranch(model, 'hw2', 'earlier'));
    // Every arm converges on hw2, which alone precedes exit.
    expect(nextOf(def, 'hw1')).toBe('hw2');
    expect(nextOf(def, 'wait1')).toBe('hw2');
    expect(onFalseOf(def, 'saturday')).toBe('hw2');
    expect(nextOf(def, 'hw2')).toBe('exit');
  });
});
