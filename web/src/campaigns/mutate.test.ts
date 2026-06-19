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

  it('inserting a condition auto-wires onTrue→B and onFalse→a fresh exit', () => {
    const m0 = starterModel();
    const edge = m0.edges.find((e) => e.from === 'trigger')!;
    const m1 = insertOnEdge(m0, edge, 'condition', NOW);
    const def = buildDefinition(m1);
    const condId = (def.nodes.trigger as unknown as { next: string }).next;
    const cond = def.nodes[condId] as unknown as { onTrue: string; onFalse: string };
    expect(cond.onTrue).toBe('exit_1'); // original downstream
    expect(def.nodes[cond.onFalse]!.type).toBe('exit'); // freshly created terminal
    expect(() => validateCampaignDefinition(def)).not.toThrow();
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

  it('removes a condition + its exclusive descendants, keeping a reachable exit', () => {
    let m = starterModel();
    const edge = m.edges.find((e) => e.from === 'trigger')!;
    m = insertOnEdge(m, edge, 'condition', NOW); // trigger → cond(onTrue exit_1, onFalse new exit)
    const condId = m.nodes.find((n) => n.node.type === 'condition')!.id;
    const before = m.nodes.length;
    m = deleteNode(m, condId);
    const def = buildDefinition(m);
    expect(def.nodes[condId]).toBeUndefined();
    // The auto-created false-arm exit (exclusive descendant) is gone; the shared
    // onTrue target (exit_1) survives as the re-link join.
    expect(m.nodes.length).toBeLessThan(before);
    expect((def.nodes.trigger as unknown as { next: string }).next).toBe('exit_1');
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
        const type = types[Math.floor(rand() * types.length)]!;
        m = insertOnEdge(m, edge, type, NOW);
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
