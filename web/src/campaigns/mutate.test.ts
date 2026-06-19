// Unit: graph mutations stay a valid down-only tree (§9B phase 5). Imports the
// REAL runner validator (no mock) so every result is gated by production rules.
import { describe, it, expect } from 'vitest';
import { validateCampaignDefinition } from '@cdp/service-campaign-runner';
import { parseDefinition, buildDefinition, starterModel } from './model.js';
import { insertOnEdge, deleteNode, nodeSummary, MutationError } from './mutate.js';

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
});
