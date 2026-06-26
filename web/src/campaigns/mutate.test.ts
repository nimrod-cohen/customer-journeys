// Unit: graph mutations stay a valid down-only tree (§9B phase 5). Imports the
// REAL runner validator (no mock) so every result is gated by production rules.
import { describe, it, expect } from 'vitest';
import { validateCampaignDefinition } from '@cdp/service-campaign-runner';
import { parseDefinition, buildDefinition, starterModel } from './model.js';
import {
  insertOnEdge,
  insertAfterBranch,
  branchContinuation,
  deleteNode,
  nodeSummary,
  moveSubtree,
  duplicateSubtree,
  subtreeNodeIds,
  movePlan,
  canDropOnEdge,
  MutationError,
} from './mutate.js';

const NOW = new Date('2026-06-06T00:00:00Z');

function validate(model: ReturnType<typeof starterModel>): void {
  validateCampaignDefinition(buildDefinition(model));
}

describe('insertOnEdge', () => {
  it('A→B becomes A→NEW→B (down-only, validates)', () => {
    const m0 = starterModel(); // trigger → exit_1
    const edge = m0.edges.find((e) => e.from === 'trigger')!;
    const m1 = insertOnEdge(m0, edge, 'wait', NOW);
    const def = buildDefinition(m1);
    // trigger now points at the new wait; the wait points at the original exit.
    const triggerNext = (def.nodes.trigger as unknown as { next: string }).next;
    expect(triggerNext).toMatch(/^wait_/);
    expect((def.nodes[triggerNext] as unknown as { next: string }).next).toBe('exit_1');
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('inserting a condition REJOINS — BOTH arms point at the continuation (no fresh exit)', () => {
    const m0 = starterModel(); // trigger → exit_1
    const edge = m0.edges.find((e) => e.from === 'trigger')!;
    const beforeExits = m0.nodes.filter((n) => n.node.type === 'exit').length;
    const m1 = insertOnEdge(m0, edge, 'condition', NOW);
    const def = buildDefinition(m1);
    const condId = (def.nodes.trigger as unknown as { next: string }).next;
    expect(condId).toMatch(/^condition_/);
    const cond = def.nodes[condId] as unknown as { onTrue: string; onFalse: string };
    // BOTH arms point at the ORIGINAL downstream (the join) — a converging diamond.
    expect(cond.onTrue).toBe('exit_1');
    expect(cond.onFalse).toBe('exit_1');
    // NO fresh exit was minted — exit count is unchanged.
    const afterExits = m1.nodes.filter((n) => n.node.type === 'exit').length;
    expect(afterExits).toBe(beforeExits);
    expect(afterExits).toBe(1);
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('the condition insert produces exactly ONE join (a node with 2 incoming edges)', () => {
    const m0 = starterModel();
    const edge = m0.edges.find((e) => e.from === 'trigger')!;
    const m1 = insertOnEdge(m0, edge, 'condition', NOW);
    const def = buildDefinition(m1);
    // Count parents across every outgoing slot.
    const parents = new Map<string, number>();
    for (const e of m1.edges) parents.set(e.to, (parents.get(e.to) ?? 0) + 1);
    const joins = [...parents.entries()].filter(([, n]) => n >= 2).map(([id]) => id);
    expect(joins).toEqual(['exit_1']);
    // trigger.next is the new condition id.
    expect((def.nodes.trigger as unknown as { next: string }).next).toMatch(/^condition_/);
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('per-arm insert: a send on the Yes (onTrue) arm lands BETWEEN If and the join', () => {
    let m = starterModel();
    const e0 = m.edges.find((e) => e.from === 'trigger')!;
    m = insertOnEdge(m, e0, 'condition', NOW); // trigger → cond(both arms → exit_1)
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'send', NOW); // cond.onTrue → send_N → exit_1
    const def = buildDefinition(m);
    const cond = def.nodes[condId] as unknown as { onTrue: string; onFalse: string };
    const sendId = cond.onTrue;
    expect(def.nodes[sendId]!.type).toBe('action');
    expect((def.nodes[sendId] as unknown as { next: string }).next).toBe('exit_1'); // arm rejoins
    expect(cond.onFalse).toBe('exit_1'); // empty arm passes straight through
    // The join exit_1 still has 2 incoming edges (from send_N + from cond.onFalse).
    const parents = m.edges.filter((e) => e.to === 'exit_1').length;
    expect(parents).toBe(2);
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('per-arm exit: inserting an exit on a converging arm terminates that arm only', () => {
    let m = starterModel();
    const e0 = m.edges.find((e) => e.from === 'trigger')!;
    m = insertOnEdge(m, e0, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const beforeExits = m.nodes.filter((n) => n.node.type === 'exit').length;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    // Inserting an exit on the converging onTrue arm is SAFE (the join stays
    // reachable via onFalse) — it must NOT throw.
    m = insertOnEdge(m, yesEdge, 'exit', NOW);
    const def = buildDefinition(m);
    const cond = def.nodes[condId] as unknown as { onTrue: string; onFalse: string };
    expect(def.nodes[cond.onTrue]!.type).toBe('exit'); // the arm terminates in a fresh exit
    expect(cond.onTrue).not.toBe('exit_1');
    expect(cond.onFalse).toBe('exit_1'); // the other arm still rejoins the continuation
    const afterExits = m.nodes.filter((n) => n.node.type === 'exit').length;
    expect(afterExits).toBe(beforeExits + 1); // exactly one new exit
    // The continuation is NOT orphaned (still reachable via onFalse).
    expect(def.nodes.exit_1).toBeDefined();
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('still GUARDS an exit insert on a NON-converging single-out edge (would orphan B)', () => {
    let m = starterModel();
    const e0 = m.edges.find((e) => e.from === 'trigger')!;
    m = insertOnEdge(m, e0, 'wait', NOW); // trigger → wait_1 → exit_1
    const waitEdge = m.edges.find((e) => e.from === 'trigger' && e.to.startsWith('wait_'))!;
    // Inserting an exit on trigger→wait_1 would orphan wait_1's subtree → refuse.
    expect(() => insertOnEdge(m, waitEdge, 'exit', NOW)).toThrow(MutationError);
  });

  it('multiple inserts keep the graph valid', () => {
    let m = starterModel();
    for (const type of ['wait', 'send', 'set_attribute', 'webhook', 'hour_of_day_window'] as const) {
      const edge = m.edges.find((e) => e.from === 'trigger')!;
      m = insertOnEdge(m, edge, type, NOW);
      expect(() => validate(m)).not.toThrow();
    }
  });
});

describe('insertAfterBranch', () => {
  it('inserts N between BOTH arms and the continuation: both arms → N → C', () => {
    // trigger → cond(both arms → exit_1). Insert a wait AFTER the branch, before exit_1.
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    expect(branchContinuation(m, condId)).toBe('exit_1');

    m = insertAfterBranch(m, condId, 'wait', NOW);
    const def = buildDefinition(m);
    const cond = def.nodes[condId] as unknown as { onTrue: string; onFalse: string };
    // BOTH arms now feed the new node N (not exit_1 directly).
    expect(cond.onTrue).toBe(cond.onFalse);
    const nId = cond.onTrue;
    expect(nId).not.toBe('exit_1');
    expect(def.nodes[nId]!.type).toBe('wait');
    // N → C (the continuation).
    expect((def.nodes[nId] as unknown as { next: string }).next).toBe('exit_1');
    // exit_1 now has exactly ONE incoming edge (from N) — the merge moved down.
    expect(m.edges.filter((e) => e.to === 'exit_1').length).toBe(1);
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('a POPULATED-arm diamond: only the boundary edges feeding C re-point to N', () => {
    // trigger → cond(onTrue → send → exit_1, onFalse → exit_1). S(cond)={cond,send};
    // boundary edges into C(exit_1) are send→exit_1 AND cond.onFalse→exit_1.
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'send', NOW);
    const sendId = m.nodes.find((n) => n.node.type === 'action')!.id;

    m = insertAfterBranch(m, condId, 'wait', NOW);
    const def = buildDefinition(m);
    const cond = def.nodes[condId] as unknown as { onTrue: string; onFalse: string };
    const nId = cond.onFalse; // the empty arm now goes through N
    expect(def.nodes[nId]!.type).toBe('wait');
    expect((def.nodes[nId] as unknown as { next: string }).next).toBe('exit_1'); // N → C
    // The populated arm: send now points at N (its boundary edge re-pointed).
    expect((def.nodes[sendId] as unknown as { next: string }).next).toBe(nId);
    // C(exit_1) has exactly one incoming edge (from N).
    expect(m.edges.filter((e) => e.to === 'exit_1').length).toBe(1);
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('rejects when the branch has NO single continuation (terminal arms)', () => {
    // trigger → cond(onTrue → exitA, onFalse → exitB): both arms END in their OWN
    // exit — no single shared continuation → branchContinuation undefined → throws.
    const m = parseDefinition({
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
        cond: { type: 'condition', ast: {}, onTrue: 'exitA', onFalse: 'exitB' },
        exitA: { type: 'exit' },
        exitB: { type: 'exit' },
      },
    });
    expect(branchContinuation(m, 'cond')).toBeUndefined();
    expect(() => insertAfterBranch(m, 'cond', 'wait', NOW)).toThrow(MutationError);
  });

  it('refuses a condition N (a merge step must be a single linear step)', () => {
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    expect(() => insertAfterBranch(m, condId, 'condition', NOW)).toThrow(MutationError);
  });

  it('refuses on a non-condition node', () => {
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'wait', NOW);
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;
    expect(() => insertAfterBranch(m, waitId, 'wait', NOW)).toThrow(MutationError);
    expect(branchContinuation(m, waitId)).toBeUndefined();
  });
});

describe('deleteNode', () => {
  it('splices a single-out node (parent re-links to its next)', () => {
    let m = starterModel();
    const edge = m.edges.find((e) => e.from === 'trigger')!;
    m = insertOnEdge(m, edge, 'wait', NOW); // trigger → wait_1 → exit_1
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;
    m = deleteNode(m, waitId);
    const def = buildDefinition(m);
    expect(def.nodes[waitId]).toBeUndefined(); // gone
    expect((def.nodes.trigger as unknown as { next: string }).next).toBe('exit_1'); // re-linked
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('collapses a REJOIN diamond: condition spliced, parents re-link to the shared join', () => {
    let m = starterModel();
    const edge = m.edges.find((e) => e.from === 'trigger')!;
    m = insertOnEdge(m, edge, 'condition', NOW); // trigger → cond(both arms → exit_1)
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    m = deleteNode(m, condId);
    const def = buildDefinition(m);
    expect(def.nodes[condId]).toBeUndefined();
    // The shared continuation (exit_1) survives; the trigger collapses straight to it.
    expect((def.nodes.trigger as unknown as { next: string }).next).toBe('exit_1');
    expect(def.nodes.exit_1!.type).toBe('exit');
    // Exactly one exit (no orphan, none lost).
    expect(m.nodes.filter((n) => n.node.type === 'exit').length).toBe(1);
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('collapses a populated-arm diamond: parent re-links to the onTrue survivor → join', () => {
    let m = starterModel();
    const e0 = m.edges.find((e) => e.from === 'trigger')!;
    m = insertOnEdge(m, e0, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'send', NOW); // cond.onTrue→send_N→exit_1; onFalse→exit_1
    const sendId = m.nodes.find((n) => n.node.type === 'action')!.id;
    m = deleteNode(m, condId);
    const def = buildDefinition(m);
    expect(def.nodes[condId]).toBeUndefined();
    // The parent re-links to the onTrue survivor (the send), which still reaches the join.
    expect((def.nodes.trigger as unknown as { next: string }).next).toBe(sendId);
    expect((def.nodes[sendId] as unknown as { next: string }).next).toBe('exit_1');
    expect(def.nodes.exit_1!.type).toBe('exit');
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('collapses when the onTrue arm TERMINATES in its own exit (keeps a reachable exit)', () => {
    let m = starterModel();
    const e0 = m.edges.find((e) => e.from === 'trigger')!;
    m = insertOnEdge(m, e0, 'condition', NOW); // both arms → exit_1
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'exit', NOW); // onTrue → fresh exitT; onFalse → exit_1
    m = deleteNode(m, condId);
    const def = buildDefinition(m);
    expect(def.nodes[condId]).toBeUndefined();
    // The parent re-links to the onTrue survivor (the fresh terminal exit); the
    // onFalse-only continuation (exit_1) is now exclusive and removed as an orphan.
    const triggerNext = (def.nodes.trigger as unknown as { next: string }).next;
    expect(def.nodes[triggerNext]!.type).toBe('exit');
    // A reachable exit remains + the graph validates (no orphan).
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('refuses to delete the trigger', () => {
    const m = starterModel();
    expect(() => deleteNode(m, m.start)).toThrow(MutationError);
  });

  it('refuses to remove the last reachable exit', () => {
    const m = starterModel(); // trigger → exit_1 (the only exit)
    expect(() => deleteNode(m, 'exit_1')).toThrow(MutationError);
  });
});

describe('no back-edge is constructable (property)', () => {
  it('a random sequence of inserts/deletes never throws cycle/orphan in the validator', () => {
    let m = starterModel();
    const types = ['wait', 'send', 'condition', 'set_attribute', 'webhook', 'hour_of_day_window'] as const;
    let seed = 12345;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let step = 0; step < 60; step++) {
      const insertable = m.edges.filter((e) => e.to !== undefined);
      if (rand() < 0.7 && insertable.length) {
        const edge = insertable[Math.floor(rand() * insertable.length)]!;
        // Include 'exit' inserts (which may rejoin-terminate an arm or guard on a
        // single-out edge) and 'condition' inserts (which REJOIN into a diamond).
        const allTypes = [...types, 'exit'] as const;
        const type = allTypes[Math.floor(rand() * allTypes.length)]!;
        try {
          m = insertOnEdge(m, edge, type, NOW);
        } catch (e) {
          // A guarded refusal (e.g. an exit insert that would orphan B) is fine —
          // the model is left unchanged and must still validate below.
          expect(e).toBeInstanceOf(MutationError);
        }
      } else {
        const deletable = m.nodes.filter((n) => n.id !== m.start && n.node.type !== 'exit');
        if (deletable.length) {
          const victim = deletable[Math.floor(rand() * deletable.length)]!;
          try {
            m = deleteNode(m, victim.id);
          } catch (e) {
            expect(e).toBeInstanceOf(MutationError); // a guarded refusal, never invalid
          }
        }
      }
      // Whatever the sequence, the current model must always validate.
      expect(() => validateCampaignDefinition(buildDefinition(m))).not.toThrow();
    }
  });
});

describe('diamond round-trip identity', () => {
  it('parseDefinition(buildDefinition(m)) preserves a join with two incoming edges', () => {
    let m = starterModel();
    const e0 = m.edges.find((e) => e.from === 'trigger')!;
    m = insertOnEdge(m, e0, 'condition', NOW); // both arms → exit_1
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'send', NOW); // populated arm + empty arm
    const def = buildDefinition(m);
    const round = buildDefinition(parseDefinition(def));
    expect(round).toEqual(def);
    // The join's TWO incoming edges both survive.
    const intoExit = parseDefinition(def).edges.filter((e) => e.to === 'exit_1').length;
    expect(intoExit).toBe(2);
  });
});

describe('moveSubtree', () => {
  /**
   * A diamond with a movable single node on the Yes arm:
   *   trigger → cond(onTrue → wait → exit_1, onFalse → exit_1)
   * The WAIT has S = {wait} and continuation C = exit_1 (the join reachable via the
   * onFalse arm) — the canonical cleanly-movable single node.
   */
  function diamondArm(): { m: ReturnType<typeof starterModel>; condId: string; waitId: string } {
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'wait', NOW); // cond.onTrue→wait→exit_1 ; onFalse→exit_1
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;
    return { m, condId, waitId };
  }

  it('moves a single node to another edge (source re-links to its continuation, dest splices)', () => {
    const { m, condId, waitId } = diamondArm();
    // S(wait) = {wait}; C = exit_1. Move the WAIT onto trigger→cond.
    expect([...subtreeNodeIds(m, waitId)]).toEqual([waitId]);
    const tEdge = m.edges.find((e) => e.from === 'trigger' && e.to === condId)!;
    const moved = moveSubtree(m, waitId, tEdge);
    const def = buildDefinition(moved);
    expect((def.nodes.trigger as unknown as { next: string }).next).toBe(waitId); // dest splices wait in
    expect((def.nodes[waitId] as unknown as { next: string }).next).toBe(condId); // wait → dest target B (cond)
    expect((def.nodes[condId] as unknown as { onTrue: string }).onTrue).toBe('exit_1'); // source arm re-links to C
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('a single-out NON-condition node moves JUST itself (its tail stays put)', () => {
    // trigger → cond(onTrue→send→wait→exit_1, onFalse→exit_1). The SEND is a
    // single-out non-condition node — moving it now relocates ONLY the send (its
    // `wait` tail is left where it was, the arm closes up to the wait). We move the
    // send onto trigger→cond.
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'send', NOW); // cond.onTrue→send→exit_1
    const sendId = m.nodes.find((n) => n.node.type === 'action')!.id;
    const sendEdge = m.edges.find((e) => e.from === sendId)!;
    m = insertOnEdge(m, sendEdge, 'wait', NOW); // cond.onTrue→send→wait→exit_1
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;

    // movePlan(send) is SINGLE — S = {send} only (the tail does NOT come along).
    const plan = movePlan(m, sendId);
    expect(plan.mode).toBe('single');
    expect(new Set(subtreeNodeIds(m, sendId))).toEqual(new Set([sendId]));

    const tEdge = m.edges.find((e) => e.from === 'trigger' && e.to === condId)!;
    const moved = moveSubtree(m, sendId, tEdge);
    const def = buildDefinition(moved);
    // trigger now → send → cond (the send spliced onto trigger→cond).
    expect((def.nodes.trigger as unknown as { next: string }).next).toBe(sendId);
    expect((def.nodes[sendId] as unknown as { next: string }).next).toBe(condId);
    // The Yes arm closed up around the gap the send left → it now points at the WAIT.
    expect((def.nodes[condId] as unknown as { onTrue: string }).onTrue).toBe(waitId);
    // The wait (the tail) STAYED put, still pointing at exit_1.
    expect((def.nodes[waitId] as unknown as { next: string }).next).toBe('exit_1');
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('moves a CONDITION branch (the whole exclusive subtree relocates as a unit)', () => {
    // trigger → cond(onTrue→exit_1, onFalse→exit_1) — then drop an inner If onto the
    // Yes arm so we have a CONDITION sub-branch to move as a unit:
    //   trigger → cond(onTrue→inner(onTrue→exit_1, onFalse→exit_1), onFalse→exit_1).
    // Moving `inner` relocates the whole inner diamond (a condition root → 'branch').
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'condition', NOW); // Yes arm now holds an inner If
    const innerId = m.nodes.find((n) => n.node.type === 'condition' && n.id !== condId)!.id;

    const plan = movePlan(m, innerId);
    expect(plan.mode).toBe('branch'); // a condition root always moves its branch
    expect(plan.ids.has(innerId)).toBe(true);

    const tEdge = m.edges.find((e) => e.from === 'trigger' && e.to === condId)!;
    const moved = moveSubtree(m, innerId, tEdge);
    const def = buildDefinition(moved);
    // trigger now → inner (the moved condition root); the outer Yes arm closed to C.
    expect((def.nodes.trigger as unknown as { next: string }).next).toBe(innerId);
    expect((def.nodes[condId] as unknown as { onTrue: string }).onTrue).toBe('exit_1');
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('moving INTO its own subtree throws', () => {
    // A condition whose Yes arm holds a send: S(cond) = {cond, send}. Targeting an
    // edge inside that subtree (send→exit_1) must throw.
    let d = starterModel();
    d = insertOnEdge(d, d.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = d.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = d.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    d = insertOnEdge(d, yesEdge, 'send', NOW); // cond.onTrue→send_d→exit_1
    const sendD = d.nodes.find((n) => n.node.type === 'action')!.id;
    const inside = d.edges.find((e) => e.from === sendD)!;
    expect(() => moveSubtree(d, condId, inside)).toThrow(MutationError);
  });

  it('moving the trigger throws', () => {
    const { m } = diamondArm();
    const someEdge = m.edges.find((e) => e.from !== 'trigger')!;
    expect(() => moveSubtree(m, m.start, someEdge)).toThrow(MutationError);
  });

  it('a move onto the edge it already occupies is a no-op', () => {
    const { m, waitId } = diamondArm(); // cond.onTrue → wait → exit_1
    const armEdge = m.edges.find((e) => e.to === waitId)!;
    expect(moveSubtree(m, waitId, armEdge)).toBe(m); // unchanged reference
  });

  it('a branch whose arms rejoin a node (the merge) moves onto a sibling arm WITHOUT orphaning — it rejoins the destination', () => {
    // trigger → cond(onTrue → exitA, onFalse → inner(onTrue→exit_1, onFalse→exit_1)).
    // The inner condition's arms REJOIN at exit_1 → its unit is S={inner}, C=exit_1
    // (conditionMerge — not the whole tail). Moving it onto the Yes arm cond→exitA
    // relocates JUST the branch: its arms now rejoin the destination (exitA) and the
    // old continuation (exit_1) stays reachable via cond.onFalse → NO orphan, a valid
    // graph the server accepts. (Before, exclusiveSubtree swallowed exit_1 with no
    // continuation and the move orphaned exitA.)
    let m = starterModel(); // trigger → exit_1
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW); // both arms → exit_1
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'exit', NOW); // onTrue → exitA ; onFalse → exit_1
    const noEdge = m.edges.find((e) => e.from === condId && e.slot === 'onFalse')!;
    m = insertOnEdge(m, noEdge, 'condition', NOW); // onFalse → inner(onTrue→exit_1, onFalse→exit_1)
    const innerId = m.nodes.find((n) => n.node.type === 'condition' && n.id !== condId)!.id;
    const exitA = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!.to;

    // conditionMerge unit: inner's continuation is exit_1 (the rejoin), S = {inner}.
    const plan = movePlan(m, innerId);
    expect(plan.continuation).toBe('exit_1');
    expect([...plan.ids]).toEqual([innerId]);

    const armToExitA = m.edges.find((e) => e.from === condId && e.to === exitA)!;
    const moved = moveSubtree(m, innerId, armToExitA);
    const def = buildDefinition(moved);
    // exitA reachable via the relocated inner; exit_1 still reachable via cond.onFalse.
    expect((def.nodes[condId] as unknown as { onTrue: string }).onTrue).toBe(innerId);
    expect((def.nodes[condId] as unknown as { onFalse: string }).onFalse).toBe('exit_1');
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('subtreeNodeIds on a CONDITION returns the exclusive members (root + arm-only descendants), NOT a SHARED join', () => {
    // trigger → outer(onTrue → inner(onTrue→send→exit_1, onFalse→exit_1), onFalse→exit_1).
    // exit_1 is reachable via the OUTER onFalse arm too, so it is a SHARED join — it
    // is NOT exclusive to the inner condition. The inner condition's exclusive
    // subtree is {inner, send}; exit_1 stays out. (A condition root still uses the
    // exclusive-subtree shape — unchanged.)
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const outerId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const outerYes = m.edges.find((e) => e.from === outerId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, outerYes, 'condition', NOW); // outer.onTrue → inner diamond
    const innerId = m.nodes.find((n) => n.node.type === 'condition' && n.id !== outerId)!.id;
    const innerYes = m.edges.find((e) => e.from === innerId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, innerYes, 'send', NOW); // inner.onTrue → send → exit_1
    const sendId = m.nodes.find((n) => n.node.type === 'action')!.id;

    const ids = subtreeNodeIds(m, innerId);
    expect(ids.has(innerId)).toBe(true);
    expect(ids.has(sendId)).toBe(true);
    expect(ids.has('exit_1')).toBe(false); // the SHARED continuation is NOT in S
    expect(ids.has(outerId)).toBe(false); // an ancestor is never in S

    // A single-out NON-condition node (the send) yields just ITSELF (single mode).
    expect([...subtreeNodeIds(m, sendId)]).toEqual([sendId]);
  });

  it('a SOLE-TRUNK condition whose arms rejoin the only exit can be DUPLICATED before itself (the reported bug)', () => {
    // trigger → cond(onTrue→wait→exit_1, onFalse→exit_1). The arms rejoin exit_1, which
    // is reachable ONLY via this branch → exclusiveSubtree swallowed it (C undefined),
    // leaving the copy unplaceable. conditionMerge gives S={cond,wait}, C=exit_1, so the
    // incoming edge (trigger→cond) is a valid drop target and the copy rejoins exit_1.
    let m = starterModel(); // trigger → exit_1
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW); // cond, both arms → exit_1
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'wait', NOW); // onTrue → wait → exit_1 ; onFalse → exit_1
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;

    // The unit is the arms rejoining exit_1 (NOT the swallowed exit).
    const plan = movePlan(m, condId);
    expect(plan.continuation).toBe('exit_1');
    expect(plan.ids.has(condId)).toBe(true);
    expect(plan.ids.has(waitId)).toBe(true);
    expect(plan.ids.has('exit_1')).toBe(false);

    // The branch's OWN incoming edge (trigger→cond) is now a valid drop target…
    const incoming = m.edges.find((e) => e.from === 'trigger' && e.to === condId)!;
    expect(canDropOnEdge(m, condId, incoming)).toBe(true);
    // …while edges INSIDE the branch are not.
    const armEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    expect(canDropOnEdge(m, condId, armEdge)).toBe(false);

    // Duplicating onto that incoming edge places the copy BEFORE the original, rejoining
    // the original condition; the originals are intact and the graph validates.
    const dup = duplicateSubtree(m, condId, incoming);
    const def = buildDefinition(dup);
    expect(Object.values(def.nodes).filter((n) => n.type === 'condition')).toHaveLength(2);
    expect((def.nodes.trigger as unknown as { next: string }).next).not.toBe(condId); // → the clone
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });
});

describe('movePlan + canDropOnEdge (single-out non-condition node moves JUST itself)', () => {
  /**
   * The bug shape: trigger → If(empty arms: onTrue & onFalse BOTH → update) →
   * update(Set first_name) → exit. The `update` node is the single shared
   * continuation of both arms; moving it onto an arm must be offered.
   */
  function emptyIfThenUpdate(): {
    m: ReturnType<typeof starterModel>;
    condId: string;
    updateId: string;
    exitId: string;
  } {
    let m = starterModel(); // trigger → exit_1
    // Insert an update (set_attribute) on trigger→exit_1: trigger→update→exit_1.
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'set_attribute', NOW);
    const updateId = m.nodes.find((n) => n.node.type === 'action')!.id;
    // Insert a condition on trigger→update: trigger→cond(onTrue→update, onFalse→update)→…
    const tEdge = m.edges.find((e) => e.from === 'trigger' && e.to === updateId)!;
    m = insertOnEdge(m, tEdge, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    return { m, condId, updateId, exitId: 'exit_1' };
  }

  it('movePlan on the empty-If shared continuation is SINGLE (ids = {update})', () => {
    const { m, updateId } = emptyIfThenUpdate();
    const plan = movePlan(m, updateId);
    expect(plan.mode).toBe('single');
    expect([...plan.ids]).toEqual([updateId]);
    expect(plan.continuation).toBe('exit_1'); // update.next
  });

  it('canDropOnEdge is TRUE for BOTH empty-If arm edges (they target the moving node), FALSE for its own out-edge', () => {
    const { m, condId, updateId } = emptyIfThenUpdate();
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    const noEdge = m.edges.find((e) => e.from === condId && e.slot === 'onFalse')!;
    expect(yesEdge.to).toBe(updateId);
    expect(noEdge.to).toBe(updateId);
    // Both arm edges (parent edges targeting the moving node) are valid destinations.
    expect(canDropOnEdge(m, updateId, yesEdge)).toBe(true);
    expect(canDropOnEdge(m, updateId, noEdge)).toBe(true);
    // The node's OWN out-edge (update→exit_1) is NOT a valid destination.
    const ownEdge = m.edges.find((e) => e.from === updateId)!;
    expect(canDropOnEdge(m, updateId, ownEdge)).toBe(false);
  });

  it('THE BUG REPRO: moving `update` onto the Yes arm → cond.onTrue→update→exit, cond.onFalse→exit', () => {
    const { m, condId, updateId } = emptyIfThenUpdate();
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    const moved = moveSubtree(m, updateId, yesEdge);
    const def = buildDefinition(moved);
    // onTrue now flows through the update before the exit; onFalse passes straight to exit.
    expect((def.nodes[condId] as unknown as { onTrue: string }).onTrue).toBe(updateId);
    expect((def.nodes[updateId] as unknown as { next: string }).next).toBe('exit_1');
    expect((def.nodes[condId] as unknown as { onFalse: string }).onFalse).toBe('exit_1');
    // exit_1 is now the 2-incoming merge (cond.onFalse + update). Valid def.
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('single-node move on a plain LINEAR chain moves just the node (the tail stays)', () => {
    // trigger → wait → send → exit_1. Move the SEND up onto trigger→wait.
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'wait', NOW); // trigger→wait→exit_1
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;
    m = insertOnEdge(m, m.edges.find((e) => e.from === waitId)!, 'send', NOW); // trigger→wait→send→exit_1
    const sendId = m.nodes.find((n) => n.node.type === 'action')!.id;

    const tEdge = m.edges.find((e) => e.from === 'trigger' && e.to === waitId)!;
    const moved = moveSubtree(m, sendId, tEdge);
    const def = buildDefinition(moved);
    // trigger → send → wait → exit_1 (the send relocated; wait stays; exit unchanged).
    expect((def.nodes.trigger as unknown as { next: string }).next).toBe(sendId);
    expect((def.nodes[sendId] as unknown as { next: string }).next).toBe(waitId);
    expect((def.nodes[waitId] as unknown as { next: string }).next).toBe('exit_1');
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('duplicate of a single node = one fresh node inserted, original intact', () => {
    const { m, condId, updateId } = emptyIfThenUpdate();
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    const dup = duplicateSubtree(m, updateId, yesEdge);
    const def = buildDefinition(dup);
    const actions = Object.values(def.nodes).filter((n) => n.type === 'action');
    expect(actions.length).toBe(2); // one fresh clone
    expect(def.nodes[updateId]).toBeDefined(); // original intact (still the onFalse target)
    const cloneId = (def.nodes[condId] as unknown as { onTrue: string }).onTrue;
    expect(cloneId).not.toBe(updateId);
    expect((def.nodes[cloneId] as unknown as { next: string }).next).toBe(updateId); // clone → dest target B
    // onFalse still points at the original update (untouched).
    expect((def.nodes[condId] as unknown as { onFalse: string }).onFalse).toBe(updateId);
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('moving a node onto its OWN out-edge throws', () => {
    const { m, updateId } = emptyIfThenUpdate();
    const ownEdge = m.edges.find((e) => e.from === updateId)!;
    expect(() => moveSubtree(m, updateId, ownEdge)).toThrow(MutationError);
  });
});

describe('duplicateSubtree', () => {
  it('duplicates a single node sharing a continuation (fresh id, original intact)', () => {
    // trigger → cond(onTrue → wait → exit_1, onFalse → exit_1). The Yes-arm WAIT has
    // S = {wait}; C = exit_1 (the join). Duplicate it onto the onFalse arm.
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'wait', NOW); // cond.onTrue→wait→exit_1 ; onFalse→exit_1
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;
    expect([...subtreeNodeIds(m, waitId)]).toEqual([waitId]);
    const noEdge = m.edges.find((e) => e.from === condId && e.slot === 'onFalse')!;
    const dup = duplicateSubtree(m, waitId, noEdge); // onFalse→cloneWait→exit_1
    const def = buildDefinition(dup);
    const waits = Object.values(def.nodes).filter((n) => n.type === 'wait');
    expect(waits.length).toBe(2); // a second wait exists
    expect(def.nodes[waitId]).toBeDefined(); // the original is intact
    const cloneId = (def.nodes[condId] as unknown as { onFalse: string }).onFalse;
    expect(cloneId).not.toBe(waitId); // the onFalse arm now goes through a fresh clone
    expect((def.nodes[cloneId] as unknown as { type: string }).type).toBe('wait');
    expect((def.nodes[cloneId] as unknown as { next: string }).next).toBe('exit_1'); // clone boundary → C
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('duplicates a CONDITION branch (fresh ids for all members, internal edges remapped, original intact)', () => {
    // A condition root duplicates its WHOLE exclusive subtree. Build an inner If on
    // the Yes arm of an outer If, with a send inside the inner Yes arm:
    //   trigger → outer(onTrue→inner(onTrue→send→exit_1, onFalse→exit_1), onFalse→exit_1)
    // Duplicating `inner` clones {inner, send} with fresh ids onto the outer onFalse arm.
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const outerId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const outerYes = m.edges.find((e) => e.from === outerId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, outerYes, 'condition', NOW); // outer.onTrue → inner (diamond)
    const innerId = m.nodes.find((n) => n.node.type === 'condition' && n.id !== outerId)!.id;
    const innerYes = m.edges.find((e) => e.from === innerId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, innerYes, 'send', NOW); // inner.onTrue → send → exit_1
    const sendId = m.nodes.find((n) => n.node.type === 'action')!.id;

    // movePlan(inner) is BRANCH with S ⊇ {inner, send}.
    const plan = movePlan(m, innerId);
    expect(plan.mode).toBe('branch');
    expect(plan.ids.has(innerId)).toBe(true);
    expect(plan.ids.has(sendId)).toBe(true);

    const outerNo = m.edges.find((e) => e.from === outerId && e.slot === 'onFalse')!;
    const dup = duplicateSubtree(m, innerId, outerNo); // clones the inner diamond onto onFalse
    const def = buildDefinition(dup);
    const conds = Object.values(def.nodes).filter((n) => n.type === 'condition');
    const sends = Object.values(def.nodes).filter((n) => n.type === 'action');
    expect(conds.length).toBe(3); // outer + inner + cloned inner
    expect(sends.length).toBe(2); // send + cloned send
    // Originals untouched; the outer onFalse now points at a FRESH cloned condition.
    expect(def.nodes[innerId]).toBeDefined();
    expect(def.nodes[sendId]).toBeDefined();
    const cloneRootId = (def.nodes[outerId] as unknown as { onFalse: string }).onFalse;
    expect(cloneRootId).not.toBe(innerId);
    expect((def.nodes[cloneRootId] as unknown as { type: string }).type).toBe('condition');
    // The clone's onTrue points at its OWN cloned send (remapped), not the original.
    const cloneYes = (def.nodes[cloneRootId] as unknown as { onTrue: string }).onTrue;
    expect(cloneYes).not.toBe(sendId);
    expect((def.nodes[cloneYes] as unknown as { type: string }).type).toBe('action');
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('duplicating the trigger throws', () => {
    const m = starterModel();
    const edge = m.edges.find((e) => e.from === 'trigger')!;
    expect(() => duplicateSubtree(m, m.start, edge)).toThrow(MutationError);
  });
});

describe('hasCycle (down-only guard)', () => {
  it('a synthetic back-edge is caught (move/duplicate would reject it)', () => {
    // Hand-build a definition with a back-edge wait→trigger and verify the local
    // guards (used by move/duplicate) reject any def that contains it. We exercise
    // the guard indirectly through buildDefinition + the validator agreeing.
    const cyclic = {
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'segment_entry', next: 'w' } as Record<string, unknown> & { type: string },
        w: { type: 'wait', delay: { seconds: 1 }, next: 'trigger' } as Record<string, unknown> & { type: string },
        x: { type: 'exit' } as Record<string, unknown> & { type: string },
      },
    };
    // The production validator must reject the cycle too (parity with hasCycle).
    expect(() => validateCampaignDefinition(cyclic)).toThrow();
  });
});

describe('nodeSummary', () => {
  it('renders short human labels per node type', () => {
    const m = parseDefinition({
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'segment_entry', next: 'w' },
        w: { type: 'wait', delay: { seconds: 172800 }, next: 'c' },
        c: { type: 'condition', ast: {}, onTrue: 's', onFalse: 'x' },
        s: { type: 'action', kind: 'send', template_id: 't', next: 'x' },
        x: { type: 'exit' },
      },
    });
    const byId = (id: string) => m.nodes.find((n) => n.id === id)!;
    expect(nodeSummary(byId('trigger'))).toBe('On segment entry');
    expect(nodeSummary(byId('w'))).toBe('Wait 2 days');
    expect(nodeSummary(byId('c'))).toBe('If / branch');
    expect(nodeSummary(byId('s'))).toBe('Send email');
    expect(nodeSummary(byId('x'))).toBe('Exit');
  });

  it('reflects the send medium (SMS / WhatsApp / email)', () => {
    const m = parseDefinition({
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'sms' },
        sms: { type: 'action', kind: 'send', medium: 'sms', text_body: 'Hi', next: 'wa' },
        wa: { type: 'action', kind: 'send', medium: 'whatsapp', text_body: 'Yo', next: 'em' },
        em: { type: 'action', kind: 'send', medium: 'email', template_id: 't', next: 'x' },
        x: { type: 'exit' },
      },
    });
    const byId = (id: string) => m.nodes.find((n) => n.id === id)!;
    expect(nodeSummary(byId('sms'))).toBe('Send SMS');
    expect(nodeSummary(byId('wa'))).toBe('Send WhatsApp');
    expect(nodeSummary(byId('em'))).toBe('Send email');
  });

  it('profile trigger summary reflects the profileChange', () => {
    const make = (profileChange?: string) =>
      parseDefinition({
        startNode: 'trigger',
        nodes: {
          trigger: { type: 'trigger', kind: 'profile', ...(profileChange ? { profileChange } : {}), next: 'x' },
          x: { type: 'exit' },
        },
      }).nodes.find((n) => n.id === 'trigger')!;
    expect(nodeSummary(make('created'))).toBe('On profile created');
    expect(nodeSummary(make('updated'))).toBe('On profile updated');
    expect(nodeSummary(make('any'))).toBe('On profile created or updated');
    expect(nodeSummary(make())).toBe('On profile created or updated'); // default any
  });

  it('a named condition shows its label instead of the generic "If / branch"', () => {
    const m = parseDefinition({
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'segment_entry', next: 'c' },
        c: { type: 'condition', label: 'VIP?', ast: {}, onTrue: 'x', onFalse: 'x' },
        x: { type: 'exit' },
      },
    });
    expect(nodeSummary(m.nodes.find((n) => n.id === 'c')!)).toBe('VIP?');
  });

  it('a named trigger shows its label instead of the generic kind text', () => {
    const m = parseDefinition({
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'segment_entry', label: 'New VIPs', next: 'x' },
        x: { type: 'exit' },
      },
    });
    expect(nodeSummary(m.nodes.find((n) => n.id === 'trigger')!)).toBe('New VIPs');
  });

  it('set_attribute summary: 1 assignment → "Set <key>", N → "Set N attributes"', () => {
    const one = parseDefinition({
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'a' },
        a: { type: 'action', kind: 'set_attribute', assignments: [{ key: 'tier', value: { kind: 'literal', value: 'gold' } }], next: 'x' },
        x: { type: 'exit' },
      },
    });
    expect(nodeSummary(one.nodes.find((n) => n.id === 'a')!)).toBe('Set tier');

    const many = parseDefinition({
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'a' },
        a: {
          type: 'action', kind: 'set_attribute',
          assignments: [
            { key: 'tier', value: { kind: 'literal', value: 'gold' } },
            { key: 'stage', value: { kind: 'literal', value: 'won' } },
          ],
          next: 'x',
        },
        x: { type: 'exit' },
      },
    });
    expect(nodeSummary(many.nodes.find((n) => n.id === 'a')!)).toBe('Set 2 attributes');

    // Legacy single key/value still summarizes (back-compat).
    const legacy = parseDefinition({
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'a' },
        a: { type: 'action', kind: 'set_attribute', key: 'plan', value: 'pro', next: 'x' },
        x: { type: 'exit' },
      },
    });
    expect(nodeSummary(legacy.nodes.find((n) => n.id === 'a')!)).toBe('Set plan');
  });
});
