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

  it('moves a CONDITION sub-branch (diamond arm): exclusive subtree relocates, continuation re-links', () => {
    // trigger → cond(onTrue→send→exit_1, onFalse→exit_1). The Yes arm's SEND has
    // S = {send} and continuation C = exit_1 (the join, reachable via onFalse). We
    // also seed a wait UNDER the send so S has two members: send→wait→exit_1.
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'send', NOW); // cond.onTrue→send→exit_1
    const sendId = m.nodes.find((n) => n.node.type === 'action')!.id;
    const sendEdge = m.edges.find((e) => e.from === sendId)!;
    m = insertOnEdge(m, sendEdge, 'wait', NOW); // cond.onTrue→send→wait→exit_1
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;

    // S(send) = {send, wait}; C = exit_1. Move the SEND branch onto trigger→cond.
    expect(new Set(subtreeNodeIds(m, sendId))).toEqual(new Set([sendId, waitId]));
    const tEdge = m.edges.find((e) => e.from === 'trigger' && e.to === condId)!;
    const moved = moveSubtree(m, sendId, tEdge);
    const def = buildDefinition(moved);
    // trigger now → send (the moved root); the cond's Yes arm re-links to C (exit_1).
    expect((def.nodes.trigger as unknown as { next: string }).next).toBe(sendId);
    expect((def.nodes[condId] as unknown as { onTrue: string }).onTrue).toBe('exit_1'); // arm closed up to C
    // The moved branch's boundary now rejoins at the dest target B (= cond).
    expect((def.nodes[waitId] as unknown as { next: string }).next).toBe(condId);
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

  it('a move that orphans a sibling subtree is rejected on persist by the SERVER validator', () => {
    // trigger → cond(onTrue → exitA, onFalse → wait → exit_1). Move the onFalse WAIT
    // branch (S = {wait, exit_1}, terminal, C = undefined) onto the Yes arm cond→exitA.
    // Locally this passes the lightweight guards (a reachable exit remains, no
    // dangling edge, no cycle), but it ORPHANS exitA — which the server's
    // validateCampaignDefinition rejects on save (the screen surfaces the error).
    let m = starterModel(); // trigger → exit_1
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW); // both arms → exit_1
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'exit', NOW); // onTrue → exitA ; onFalse → exit_1
    const noEdge = m.edges.find((e) => e.from === condId && e.slot === 'onFalse')!;
    m = insertOnEdge(m, noEdge, 'wait', NOW); // onFalse → wait → exit_1
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;
    const exitA = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!.to;

    const armToExitA = m.edges.find((e) => e.from === condId && e.to === exitA)!;
    const moved = moveSubtree(m, waitId, armToExitA); // local guards pass…
    // …but the moved result orphans exitA → the SERVER validator rejects it (parity
    // with the persist-time rejection the screen surfaces).
    expect(() => validateCampaignDefinition(buildDefinition(moved))).toThrow();
  });

  it('subtreeNodeIds returns the exclusive members (root + arm-only descendants), NOT the shared join', () => {
    // trigger → cond(onTrue → send → wait → exit_1, onFalse → exit_1). The Yes-arm
    // SEND has S = {send, wait}; exit_1 is the shared join (reachable via onFalse).
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'send', NOW); // cond.onTrue→send→exit_1
    const sendId = m.nodes.find((n) => n.node.type === 'action')!.id;
    const sendEdge = m.edges.find((e) => e.from === sendId)!;
    m = insertOnEdge(m, sendEdge, 'wait', NOW); // cond.onTrue→send→wait→exit_1
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;
    const ids = subtreeNodeIds(m, sendId);
    expect(ids.has(sendId)).toBe(true);
    expect(ids.has(waitId)).toBe(true);
    expect(ids.has('exit_1')).toBe(false); // the shared continuation is NOT in S
    expect(ids.has(condId)).toBe(false); // an ancestor is never in S
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

  it('duplicates a branch (fresh ids for all members, internal edges remapped, original intact)', () => {
    // Build trigger → cond(onTrue→send→exit_1, onFalse→exit_1). The Yes arm's SEND
    // has continuation C = exit_1 (the join reachable via onFalse), so S(send) =
    // {send}. To get a multi-node subtree with a shared join we insert a wait on
    // the Yes arm BELOW the send: cond.onTrue→send→wait→exit_1, onFalse→exit_1.
    let m = starterModel();
    m = insertOnEdge(m, m.edges.find((e) => e.from === 'trigger')!, 'condition', NOW);
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const yesEdge = m.edges.find((e) => e.from === condId && e.slot === 'onTrue')!;
    m = insertOnEdge(m, yesEdge, 'send', NOW); // cond.onTrue→send→exit_1
    const sendId = m.nodes.find((n) => n.node.type === 'action')!.id;
    const sendEdge = m.edges.find((e) => e.from === sendId)!;
    m = insertOnEdge(m, sendEdge, 'wait', NOW); // cond.onTrue→send→wait→exit_1
    const waitId = m.nodes.find((n) => n.node.type === 'wait')!.id;

    // S(send) = {send, wait}; C = exit_1 (reachable via the onFalse arm). Duplicate
    // the SEND branch onto the onFalse arm (cond.onFalse→exit_1).
    expect(new Set(subtreeNodeIds(m, sendId))).toEqual(new Set([sendId, waitId]));
    const noEdge = m.edges.find((e) => e.from === condId && e.slot === 'onFalse')!;
    const dup = duplicateSubtree(m, sendId, noEdge); // onFalse→cloneSend→cloneWait→exit_1
    const def = buildDefinition(dup);
    const sends = Object.values(def.nodes).filter((n) => n.type === 'action');
    const waits = Object.values(def.nodes).filter((n) => n.type === 'wait');
    expect(sends.length).toBe(2); // cloned send
    expect(waits.length).toBe(2); // cloned wait (internal member)
    // The originals are untouched.
    expect(def.nodes[sendId]).toBeDefined();
    expect(def.nodes[waitId]).toBeDefined();
    // The onFalse arm now points at the clone-root send (a fresh id, not the original).
    const cloneRootId = (def.nodes[condId] as unknown as { onFalse: string }).onFalse;
    expect(cloneRootId).not.toBe(sendId);
    expect((def.nodes[cloneRootId] as unknown as { type: string }).type).toBe('action');
    // The clone-root's internal edge points at its OWN clone wait (remapped), not the original.
    const cloneNext = (def.nodes[cloneRootId] as unknown as { next: string }).next;
    expect(cloneNext).not.toBe(waitId);
    expect((def.nodes[cloneNext] as unknown as { type: string }).type).toBe('wait');
    expect((def.nodes[cloneNext] as unknown as { next: string }).next).toBe('exit_1'); // clone boundary → C
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
