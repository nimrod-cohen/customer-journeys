// Phase 3: persist + validate the TRIGGER definition for all three kinds
// (segment_entry | event | manual). The event trigger node carries an event type
// + optional payload filter (an AstNode); manual carries no auto-source; the
// structural gate (validateAutomationDefinition) still passes/fails correctly and
// the new event fields ride the existing cycle/orphan/edge invariants.
import { describe, it, expect } from 'vitest';
import { validateAutomationDefinition } from '../src/dsl.js';

describe('validateAutomationDefinition — trigger definition for all three kinds', () => {
  it('ACCEPTS an optional cosmetic trigger `label` (never affects routing/validation)', () => {
    for (const kind of ['segment_entry', 'manual'] as const) {
      const def = {
        startNode: 't',
        nodes: { t: { type: 'trigger', kind, label: 'New VIPs', next: 'x' }, x: { type: 'exit' } },
      };
      expect(() => validateAutomationDefinition(def)).not.toThrow();
    }
    const ev = {
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'event', eventType: 'purchase', label: 'Bought something', next: 'x' }, x: { type: 'exit' } },
    };
    expect(() => validateAutomationDefinition(ev)).not.toThrow();
  });

  it('ACCEPTS an event trigger with eventType and no filter', () => {
    const def = {
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'event', eventType: 'purchase', next: 'x' }, x: { type: 'exit' } },
    };
    expect(() => validateAutomationDefinition(def)).not.toThrow();
  });

  it('ACCEPTS an event trigger with eventType AND an optional payload filter (AstNode)', () => {
    const def = {
      startNode: 't',
      nodes: {
        t: {
          type: 'trigger',
          kind: 'event',
          eventType: 'purchase',
          filter: { field: 'payload.amount', operator: '>=', value: 100 },
          next: 'x',
        },
        x: { type: 'exit' },
      },
    };
    expect(() => validateAutomationDefinition(def)).not.toThrow();
  });

  it('THROWS when an event trigger has a missing/empty eventType', () => {
    const missing = {
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'event', next: 'x' }, x: { type: 'exit' } },
    };
    expect(() => validateAutomationDefinition(missing)).toThrow(/eventType/);
    const empty = {
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'event', eventType: '', next: 'x' }, x: { type: 'exit' } },
    };
    expect(() => validateAutomationDefinition(empty)).toThrow(/eventType/);
  });

  it('THROWS when the optional event-trigger filter is malformed (not an object / bad AstNode)', () => {
    const notObject = {
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'event', eventType: 'purchase', filter: 'nope', next: 'x' }, x: { type: 'exit' } },
    };
    expect(() => validateAutomationDefinition(notObject)).toThrow(/filter/);
    const badAst = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'event', eventType: 'purchase', filter: { op: 'wat', conditions: [] }, next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateAutomationDefinition(badAst)).toThrow();
  });

  it('ACCEPTS a manual trigger with only { kind, next } (no auto-source fields)', () => {
    const def = {
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'manual', next: 'x' }, x: { type: 'exit' } },
    };
    expect(() => validateAutomationDefinition(def)).not.toThrow();
  });

  it('ACCEPTS a segment_entry trigger unchanged (segment lives on the automation row, not the node)', () => {
    const def = {
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'segment_entry', next: 'x' }, x: { type: 'exit' } },
    };
    expect(() => validateAutomationDefinition(def)).not.toThrow();
  });

  it('the exactly-one-trigger / edges / cycle / orphan invariants are unaffected by the event fields', () => {
    // A previously-valid multi-node graph with an event trigger still validates.
    const valid = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'event', eventType: 'signup', next: 'w' },
        w: { type: 'wait', delay: { seconds: 60 }, next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateAutomationDefinition(valid)).not.toThrow();

    // Two triggers still rejected.
    const twoTriggers = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'event', eventType: 'a', next: 't2' },
        t2: { type: 'trigger', kind: 'manual', next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateAutomationDefinition(twoTriggers)).toThrow(/exactly one trigger/);

    // A back-edge (cycle) still rejected even with an event trigger.
    const cyclic = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'event', eventType: 'a', next: 'w' },
        w: { type: 'wait', delay: { seconds: 1 }, next: 't' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateAutomationDefinition(cyclic)).toThrow();

    // An orphan node still rejected.
    const orphan = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'event', eventType: 'a', next: 'x' },
        x: { type: 'exit' },
        lost: { type: 'exit' },
      },
    };
    expect(() => validateAutomationDefinition(orphan)).toThrow(/orphan/);
  });
});
